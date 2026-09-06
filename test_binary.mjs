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
