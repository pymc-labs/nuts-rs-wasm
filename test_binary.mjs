import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sample, compatibilityResult, stageWorkerResult} from './bridge.mjs';

test('staged buffers survive transfer and compatibility conversion preserves shape', () => {
  const result = {result_format:'binary', shape:[1,2,2], unconstrained_width:1,
    expanded_samples:Float64Array.of(1,2,3,4), samples:Float64Array.of(5,6),
    stats:Float64Array.of(0,3,.1,1,7,.2), traces:[]};
  const files = new Map();
  const fs = {mkdir(){}, writeFile(path, bytes, options) {
    assert.notEqual(options?.canOwn, true); files.set(path, bytes.slice());
  }};
  const path = stageWorkerResult(result, fs, '/tmp/result');
  assert.equal(path, '/tmp/result/metadata.json');
  const nested = compatibilityResult(result);
  assert.deepEqual(nested.expanded_samples, [[[1,2],[3,4]]]);
  assert.deepEqual(nested.stats[0][1], {diverging:true,n_steps:7,step_size:.2});
  structuredClone(result, {transfer:[result.expanded_samples.buffer,result.samples.buffer,result.stats.buffer]});
  assert.equal(result.expanded_samples.byteLength, 0);
  assert.deepEqual(Array.from(new Float64Array(files.get('/tmp/result/expanded_samples.bin').buffer)), [1,2,3,4]);
});

test('real WASM binary matches compatibility and callback transfer cannot detach final buffers', async () => {
  const bytes = await readFile('adapter/target/wasm32-unknown-unknown/release/nuts_browser_adapter.wasm');
  const memory = new WebAssembly.Memory({initial:1});
  const runtime = {wasmMemory:memory, wasmTable:{get:()=> (xp,gp)=>{
    const x = new Float64Array(memory.buffer,xp,2), g = new Float64Array(memory.buffer,gp,2);
    g.set([-x[0],-x[1]]); return -(x[0]**2+x[1]**2)/2;
  }}};
  const options = {bytes,runtime,model:{initial:[.1,.2],x_pointer:0,g_pointer:16,callback_pointer:7}, chains:2,tune:30,draws:23};
  let streamed=0;
  const binary = await sample({...options,resultFormat:'binary',retainUnconstrained:false,
    onSamples(batch){streamed+=batch.draws; structuredClone(batch,{transfer:[batch.values.buffer]});},
    onTrace(trace){structuredClone(trace,{transfer:[trace.bytes.buffer]});}});
  assert.equal(streamed,46);
  assert.equal(binary.samples,undefined);
  assert.equal(binary.expanded_samples.length,92);
  assert.ok(binary.traces.every(t=>t.bytes.length>0));
  const legacy = await sample(options);
  assert.deepEqual(compatibilityResult(binary).expanded_samples,legacy.expanded_samples);
  assert.deepEqual(compatibilityResult(binary).stats,legacy.stats);
  assert.deepEqual(binary.traces,legacy.traces);
});

test('partial staging writes are removed without masking the original error', () => {
  const files = new Set(), failure = Error('disk full');
  const fs = {mkdir(){}, writeFile(path) {files.add(path); throw failure;},
    unlink(path){files.delete(path);}, rmdir(){assert.equal(files.size,0);}};
  assert.throws(()=>stageWorkerResult({expanded_samples:Float64Array.of(1)},fs,'/tmp/failure'), error=>error===failure);
  assert.equal(files.size,0);
});

async function gaussian(options = {}) {
  const bytes = await readFile('adapter/target/wasm32-unknown-unknown/release/nuts_browser_adapter.wasm');
  const memory = new WebAssembly.Memory({initial:1});
  const runtime = {wasmMemory:memory, wasmTable:{get:()=> (xp,gp)=>{
    const x = new Float64Array(memory.buffer,xp,1)[0];
    new Float64Array(memory.buffer,gp,1)[0] = -x;
    return -x*x/2;
  }}};
  return sample({bytes,runtime,model:{initial:[.2],x_pointer:0,g_pointer:8,callback_pointer:1},
    chains:2,tune:25,draws:21,resultFormat:'binary', ...options});
}
test('stream-only keeps identical draws without retained numeric or Arrow results', async () => {
  const full = await gaussian();
  const batches = [];
  const streamed = await gaussian({resultFormat:'stream', onSamples:b=>batches.push(...b.values),
    onTrace:()=>assert.fail('stream mode must not build Arrow traces')});
  assert.deepEqual(batches, Array.from(full.expanded_samples));
  assert.equal(streamed.result_format,'stream');
  for(const name of ['samples','expanded_samples','stats']) assert.equal(streamed[name],undefined);
  assert.deepEqual(streamed.traces,[]);
  assert.equal(streamed.divergences,full.divergences);
  assert.equal(streamed.leapfrog_steps,full.leapfrog_steps);
});
test('jitter is reproducible, distinct between chains and can be disabled', async () => {
  const a=await gaussian(), b=await gaussian(), c=await gaussian({seed:43});
  assert.deepEqual(a.initial_positions,b.initial_positions);
  assert.deepEqual(a.initial_positions,(await gaussian({jitter:1})).initial_positions);
  assert.deepEqual(a.expanded_samples,b.expanded_samples);
  assert.notDeepEqual(a.initial_positions[0],a.initial_positions[1]);
  assert.notDeepEqual(a.initial_positions,c.initial_positions);
  assert.ok(a.initial_positions.flat().every(x=>Math.abs(x-.2)<=1));
  assert.deepEqual((await gaussian({jitter:0})).initial_positions,[[.2],[.2]]);
  await assert.rejects(gaussian({jitter:Number.MAX_VALUE}),/initialization failed/);
});
test('tree depth limits leapfrog counts and invalid options reject', async () => {
  const result=await gaussian({maxDepth:1});
  for(let i=1;i<result.stats.length;i+=3) assert.ok(result.stats[i]<=1);
  for(const options of [{maxDepth:0},{maxDepth:21},{maxDepth:1.5},{jitter:-1},{jitter:NaN},
      {initRetries:-1},{initRetries:1001}]) await assert.rejects(gaussian(options),/Invalid/);
});
test('initialization retries recover from rejected positions and give a chain-specific error on exhaustion', async () => {
  const bytes = await readFile('adapter/target/wasm32-unknown-unknown/release/nuts_browser_adapter.wasm');
  const memory = new WebAssembly.Memory({initial:1});
  let rejected = 0;
  const runtime={wasmMemory:memory,wasmTable:{get:()=> (xp,gp)=>{
    if(rejected++ < 2) return NaN;
    const x=new Float64Array(memory.buffer,xp,1)[0];
    new Float64Array(memory.buffer,gp,1)[0]=-x; return -x*x/2;
  }}};
  const options={bytes,runtime,model:{initial:[0],x_pointer:0,g_pointer:8,callback_pointer:1},chains:1,tune:10,draws:2};
  await sample({...options,initRetries:3});
  rejected=0;
  await assert.rejects(sample({...options,initRetries:0}),/Chain 0 initialization failed/);
});

test('stream-only WASM memory does not grow with retained draw count', async t => {
  const instantiate=WebAssembly.instantiate.bind(WebAssembly), instances=[];
  t.mock.method(WebAssembly,'instantiate',async (...args)=>{
    const result=await instantiate(...args);instances.push(result.instance);return result;
  });
  await gaussian({resultFormat:'stream',chains:1,draws:100});
  await gaussian({resultFormat:'stream',chains:1,draws:10000});
  for(const {exports:ex} of instances) {
    assert.equal(ex.samples_len(),0);assert.equal(ex.expanded_len(),0);assert.equal(ex.stats_len(),0);
  }
  assert.equal(instances[0].exports.memory.buffer.byteLength,instances[1].exports.memory.buffer.byteLength);
});
