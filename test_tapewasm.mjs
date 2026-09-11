import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createSampler} from './client.mjs';

// Exercise the actual worker and published WASM in Node. Only browser transport
// APIs are shimmed; no sampler, model exports, or density calls are mocked.
class BrowserWorker {
  constructor(url) {
    this.inner = new NodeWorker(`
      const {parentPort} = await import('node:worker_threads');
      globalThis.self = globalThis;
      globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
      await import(${JSON.stringify(url.href)});
      parentPort.on('message', data => self.onmessage({data}));
    `, {eval: true, type: 'module'});
    this.inner.on('message', data => this.onmessage?.({data}));
    this.inner.on('error', error => this.onerror?.(error));
  }
  postMessage(data) {this.inner.postMessage(data);}
  terminate() {return this.inner.terminate();}
}
async function setup(t) {
  const old = globalThis.Worker; globalThis.Worker = BrowserWorker;
  t.after(() => {globalThis.Worker = old;});
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/wait') return; // closed by teardown/cancellation
      const file = process.env.TAPEWASM_MMM_DIR && ['/mmm/model.wasm','/mmm/meta.json'].includes(req.url)
        ? new URL(req.url.slice(5), 'file://' + process.env.TAPEWASM_MMM_DIR.replace(/\/?$/, '/'))
        : new URL('.' + req.url, import.meta.url);
      const data = await readFile(file);
      res.setHeader('Content-Type', req.url.endsWith('.wasm') ? 'application/wasm' : 'application/json');
      res.end(data);
    } catch {res.writeHead(404);res.end();}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => {server.closeAllConnections();server.close();});
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createSampler({backend:'tapewasm', moduleUrl:new URL('./node_modules/tapewasm/index.js',import.meta.url),
    wasmUrl:base+'/node_modules/tapewasm/pkg/tapewasm_bg.wasm', loadTimeout:10000});
  t.after(() => client.close());
  const model = name => ({wasmUrl:base+`/tests/fixtures/tapewasm/${name}.wasm`,metadataUrl:base+`/tests/fixtures/tapewasm/${name}.json`});
  return {client,model,base};
}
test('backend selection remains explicit and Numba remains default', () => {
  assert.throws(()=>createSampler({backend:'missing'}),/Unknown/);
  assert.throws(()=>createSampler({backend:'tapewasm'}),/moduleUrl/);
  assert.throws(()=>createSampler({}),/runtimeUrl/);
});
test('real WASM fits, repeatability, multiple model bindings and release', async t => {
  const {client,model} = await setup(t);
  const first = await client.prepare(model('normal'));
  const second = await client.prepare(model('shifted'));
  const options={chains:2,tune:300,draws:500,seed:91,resultFormat:'binary'};
  const r = await client.sample(first,options);
  assert.equal(r.space,'unconstrained');assert.equal(r.backend,'tapewasm');
  assert.deepEqual(r.unconstrained_shape,[2,500,1]);assert.equal(r.samples.length,1000);
  assert.ok(r.samples instanceof Float64Array);assert.ok(r.samples.every(Number.isFinite));
  assert.equal(r.expanded_samples,undefined);assert.deepEqual(r.traces,[]);
  const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
  assert.ok(Math.abs(mean(r.samples))<.2);
  const shifted = await client.sample(second,options);
  assert.ok(Math.abs(mean(shifted.samples)-3)<.2);
  assert.deepEqual((await client.sample(first,options)).samples,r.samples);
  const compat = await client.sample(first,{...options,resultFormat:'compatibility'});
  assert.deepEqual(compat.samples.flat(2),Array.from(r.samples));
  await client.release(first);await assert.rejects(client.sample(first),/invalid|expired/);
  client.close();await assert.rejects(client.sample(second),/invalid|expired/);
  const fresh = await client.sample(model('normal'),options);
  assert.deepEqual(fresh.samples,r.samples);
});
test('unsupported options, Python and invalid starts fail explicitly', async t => {
  const {client,model} = await setup(t);
  await assert.rejects(client.prepare('import pymc'),/Python source/);
  for (const options of [{targetAccept:.9},{onSamples(){}},{mutableData:true},{resultFormat:'stream'},{draws:0},{seed:-1}])
    await assert.rejects(client.sample(model('normal'),options));
  const h = await client.prepare(model('normal'));
  await assert.rejects(client.sample(h,{initialPositions:[[NaN],[.2]]}),/initialPositions/);
  await assert.rejects(client.updateData(h,{}),/fixed data/);
  await assert.rejects(client.execute('print(1)'),/Python/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(client.sample(h,{signal:abort.signal}),{name:'AbortError'});
});
test('mismatched artifacts fail; cancellation interrupts a running WASM fit', async t => {
  const {client,model} = await setup(t);
  await assert.rejects(client.prepare({...model('normal'),metadataUrl:model('shifted').metadataUrl}),/layout/);
  const h = await client.prepare(model('normal'));
  const controller=new AbortController();
  const run=client.sample(h,{draws:10000000,signal:controller.signal});
  const rejected=assert.rejects(run,{name:'AbortError'});
  await assert.rejects(client.sample(h),/already active/);
  setTimeout(()=>controller.abort(),100);
  await rejected;
  await assert.rejects(client.sample(h),/expired/);
  assert.equal(client.worker,null);
});
test('timeout terminates a blocked loader; artifact fetch errors remain recoverable',async t=>{
  const {client,model,base}=await setup(t);
  await assert.rejects(client.prepare({...model('normal'),metadataUrl:base+'/missing'}),/404/);
  client.loadTimeout=100;
  await assert.rejects(client.prepare({...model('normal'),metadataUrl:base+'/wait'}),/timed out/);
  assert.equal(client.worker,null);
  client.loadTimeout=10000;
  await client.prepare(model('normal'));
});

test('optional exact MMM through the public adapter', {skip: !process.env.TAPEWASM_MMM_DIR}, async t => {
  const {client,base}=await setup(t);
  const r=await client.sample({wasmUrl:base+'/mmm/model.wasm',metadataUrl:base+'/mmm/meta.json'},
    {chains:2,tune:750,draws:500,seed:42,resultFormat:'binary'});
  assert.deepEqual(r.unconstrained_shape,[2,500,15]);
  assert.equal(r.samples.length,15000);assert.ok(r.samples.every(Number.isFinite));
});
