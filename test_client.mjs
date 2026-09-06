import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampler} from './client.mjs';
const make = () => createSampler({runtimeUrl:'http://localhost/runtime/', environment:'test'});
test('requires runtime configuration', () => assert.throws(() => createSampler({}), /required/));
test('aborted signal never starts a worker', async () => {
  const client=make(), controller=new AbortController();controller.abort();
  await assert.rejects(client.sample('model=None',{signal:controller.signal}), {name:'AbortError'});
  assert.equal(client.busy,false);assert.equal(client.worker,null);
});
test('rejects concurrent runs and cancels outstanding initialization', async () => {
  const client=make();
  client.initialize=()=>new Promise((resolve,reject)=>{client.initReject=reject;});
  const pending=client.sample('model=None');
  await assert.rejects(client.sample('model=None'), /already active/);
  client.cancel();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(client.busy,false);
});
test('cancel rejects every outstanding execution', async () => {
  const client=make();client.worker={terminate(){}};
  client.remote={processMessage:async()=>{}};
  const pending=client.execute('x=1');client.cancel();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(client.pending.size,0);
});
const deferred = () => {let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject};};
const tick = () => new Promise(resolve => setImmediate(resolve));
function runtime(t, {metadata, initialization, loadTimeout = 1000} = {}) {
  const workers = [], calls = [], codes = [];
  class MockWorker {constructor(){workers.push(this);} terminate(){this.terminated=true;}}
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push({kind:'fetch', options}); return metadata ? metadata.promise : {ok:true,json:async()=>({})};
  });
  const previous = globalThis.Worker; globalThis.Worker=MockWorker;
  t.after(()=>{globalThis.Worker=previous;});
  let compiles = 0;
  const client=createSampler({runtimeUrl:'http://localhost/runtime/',environment:'test',loadTimeout,
    wrap:worker=>({initialize:async()=>{calls.push({kind:'initialize',worker}); if(initialization) await initialization.promise;},
      processMessage:async({msg})=>{
        codes.push(msg.content.code);
        if(msg.content.code.includes('NUTS_CONFIG ')) {
          compiles++;
          worker.onmessage({data:{header:{msg_type:'stream'},content:{text:'NUTS_CONFIG '+JSON.stringify({compile_seconds:3,initial:[0],callback_pointer:compiles})+'\n'}}});
        }
        worker.onmessage({data:{header:{msg_type:'execute_reply'},parent_header:{msg_id:msg.header.msg_id},content:{status:'ok'}}});
      },
      callGlobalReceiver:async(_receiver,_method,config,options)=>{
        calls.push({kind:'sample',config,options});
        worker.onmessage({data:{nuts:'result',result:{traces:[],python_result_path:'/tmp/result.json'}}});
      }
    })});
  t.after(()=>client.close());
  return {client,workers,calls,codes,get compiles(){return compiles;}};
}
test('concurrent initialization shares readiness and its promise', async t => {
  const metadata=deferred(), initialization=deferred(), {client,calls}=runtime(t,{metadata,initialization});
  const first=client.initialize(), second=client.initialize(); assert.equal(first,second);
  let ready=false;second.then(()=>{ready=true;});await tick();assert.equal(ready,false);
  metadata.resolve({ok:true,json:async()=>({})});await tick();assert.equal(ready,false);
  assert.equal(calls.filter(x=>x.kind==='initialize').length,1);
  initialization.resolve();await Promise.all([first,second]);assert.equal(ready,true);
});
test('concurrent initialization propagates the same failure', async t => {
  const initialization=deferred(), {client,workers}=runtime(t,{initialization});
  const first=client.initialize(), second=client.initialize();
  const checks=[assert.rejects(first,/setup failed/),assert.rejects(second,/setup failed/)];
  await tick();initialization.reject(Error('setup failed'));await Promise.all(checks);
  assert.equal(workers[0].terminated,true);assert.equal(client.worker,null);
});
test('cancelled metadata cannot initialize old or replacement workers', async t => {
  const metadata=deferred(), {client,calls,workers}=runtime(t,{metadata});
  const old=client.initialize();const rejected=assert.rejects(old,{name:'AbortError'});await tick();
  client.cancel();assert.equal(calls[0].options.signal.aborted,true);
  client.fetch=async()=>({});const replacement=client.initialize();await replacement;await rejected;
  metadata.resolve({ok:true,json:async()=>({})});await tick();
  assert.equal(workers[0].terminated,true);assert.equal(workers[1].terminated,undefined);
  assert.deepEqual(calls.filter(x=>x.kind==='initialize').map(x=>x.worker),[workers[1]]);
  assert.equal(client.initialize(),replacement);
});
test('cancelled remote setup cannot clear a replacement initialization', async t => {
  const initialization=deferred(), {client,workers}=runtime(t,{initialization});
  const old=client.initialize();const rejected=assert.rejects(old,{name:'AbortError'});await tick();client.cancel();
  const replacement=client.initialize();await tick();initialization.resolve();await Promise.all([replacement,rejected]);
  assert.equal(workers[1].terminated,undefined);assert.equal(client.initialize(),replacement);
});
test('initialization timeout rejects promptly and aborts metadata', async t => {
  const metadata=deferred(), {client,calls,workers}=runtime(t,{metadata,loadTimeout:10});
  await assert.rejects(client.initialize(),/timed out/);
  assert.equal(workers[0].terminated,true);assert.equal(calls[0].options.signal.aborted,true);
  metadata.resolve({ok:true,json:async()=>({})});await tick();
  assert.equal(calls.filter(x=>x.kind==='initialize').length,0);
});
test('explicit handles compile once across seeds and draws and keep distinct callbacks', async t => {
  const rt=runtime(t), {client,calls,codes}=rt;client.fetch=async()=>'';
  const first=await client.prepare('model=None');
  const a=await client.sample(first,{seed:1,draws:2});const b=await client.sample(first,{seed:2,draws:7,resultFormat:'binary',retainUnconstrained:false});
  assert.equal(calls.find(x=>x.kind==='sample').options.jitter,1);
  assert.equal(rt.compiles,1);assert.equal(a.compile_seconds,0);assert.equal(b.model_compile_seconds,3);
  assert.equal(b.python_result_path,undefined);assert.ok(codes.some(c=>c.includes('load_worker_result("/tmp/result.json")')));
  const second=await client.compile('model=None',{files:{'data.csv':'new'},varNames:['b']});
  await client.sample(first);await client.sample(second);
  assert.deepEqual(calls.filter(x=>x.kind==='sample').map(x=>x.config.callback_pointer),[1,1,1,2]);
  assert.deepEqual(calls.filter(x=>x.kind==='sample').slice(0,2).map(x=>x.options.draws),[2,7]);
  await assert.rejects(client.sample(first,{varNames:['different']}),/compile a new model/);
  await assert.rejects(client.sample(first,{files:{}}),/compile a new model/);
  await client.release(first);await assert.rejects(client.sample(first),/invalid/);
  client.cancel();await assert.rejects(client.sample(second),/expired/);
});
test('source convenience path remains supported and reports cold compilation', async t => {
  const rt=runtime(t);rt.client.fetch=async()=>'';
  const result=await rt.client.sample('model=None');assert.equal(result.compile_seconds,3);assert.equal(rt.compiles,1);
});
test('foreign handles are rejected before starting a runtime', async t => {
  const rt=runtime(t);rt.client.fetch=async()=>'';
  const handle=await rt.client.compile('model=None');const other=make();
  await assert.rejects(other.sample(handle),/another sampler/);assert.equal(other.worker,null);
});
test('temporary source handles are released on success and sampling failure', async t => {
  const rt=runtime(t), {client,codes}=rt;client.fetch=async()=>'';
  await client.sample('model=None');
  assert.equal(codes.filter(c=>c.includes('_nuts_models.pop(')).length,1);
  client.remote.callGlobalReceiver=async()=>{throw Error('sampler failed');};
  await assert.rejects(client.sample('model=None'),/sampler failed/);
  assert.equal(codes.filter(c=>c.includes('_nuts_models.pop(')).length,2);
});
test('reused postprocessing restores matching model and zero compilation timing', async t => {
  const rt=runtime(t), {client,codes}=rt;client.fetch=async()=>'';
  const first=await client.compile('model=first'), second=await client.compile('model=second');
  await client.sample(first,{afterSample:'inspect(model)'});
  assert.ok(codes.some(c=>c.includes(`_nuts_models["${first.id}"]=(_nuts_compiled, model)`)));
  assert.ok(codes.at(-1).includes(`_nuts_compiled,model=_nuts_models["${first.id}"]`));
  assert.ok(codes.at(-1).includes('_nuts_compile_seconds=0\n'));
  assert.ok(codes.at(-1).endsWith('inspect(model)'));
  await client.release(second);
});
test('old operation cleanup cannot reset replacement operation state', async t => {
  const rt=runtime(t), {client}=rt;const oldFetch=deferred();
  client.fetch=async url=>url.pathname.endsWith('kernel.json') ? {} : oldFetch.promise;
  const old=client.compile('model=None');const rejected=assert.rejects(old,{name:'AbortError'});
  await tick();client.cancel();
  const newFetch=deferred();client.fetch=async url=>url.pathname.endsWith('kernel.json') ? {} : newFetch.promise;
  const replacement=client.compile('model=None');await tick();
  oldFetch.resolve('');await rejected;assert.equal(client.busy,true);
  newFetch.resolve('');await replacement;assert.equal(client.busy,false);
});
test('AbortSignal cancels remote setup promptly and stale worker events are ignored', async t => {
  const initialization=deferred(), {client,workers}=runtime(t,{initialization});
  const controller=new AbortController();const sampling=client.sample('model=None',{signal:controller.signal});
  const rejected=assert.rejects(sampling,{name:'AbortError'});await tick();controller.abort();await rejected;
  const replacement=client.initialize();await tick();
  workers[0].onerror({message:'old worker failed'});
  workers[0].onmessage({data:{header:{msg_type:'stream'},content:{text:'NUTS_CONFIG {"stale":true}\n'}}});
  initialization.resolve();await replacement;assert.equal(client.config,null);
  assert.equal(workers[1].terminated,undefined);
});
test('remote initialization timeout leaves replacement safe after late rejection', async t => {
  const initialization=deferred(), {client,workers}=runtime(t,{initialization,loadTimeout:10});
  await assert.rejects(client.initialize(),/timed out/);
  client.wrap=()=>({initialize:async()=>{}});const replacement=client.initialize();await replacement;
  initialization.reject(Error('late failure'));await tick();assert.equal(workers[1].terminated,undefined);
  assert.equal(client.initialize(),replacement);
});
test('failed result helper download releases temporary compiled callbacks', async t => {
  const {client,codes}=runtime(t);client.fetch=async url=>{
    if (url.pathname.endsWith('results.py')) throw Error('helper unavailable');return '';
  };
  await assert.rejects(client.sample('model=None'),/helper unavailable/);
  assert.equal(codes.filter(c=>c.includes('_nuts_models.pop(')).length,1);
});
test('an old operation signal cannot cancel a replacement while its fetch unwinds', async t => {
  const {client,workers}=runtime(t), oldFetch=deferred(), controller=new AbortController();
  client.fetch=async url=>url.pathname.endsWith('kernel.json') ? {} : oldFetch.promise;
  const old=client.compile('model=None',{signal:controller.signal});const rejected=assert.rejects(old,{name:'AbortError'});
  await tick();client.cancel();client.fetch=async()=>'';
  const handle=await client.compile('model=None');controller.abort();
  assert.equal(workers[1].terminated,undefined);await client.sample(handle);
  oldFetch.resolve('');await rejected;
});

test('mutable data updates reuse callbacks and serialize with fits', async t => {
  const rt=runtime(t), {client,calls,codes}=rt; client.fetch=async()=>'';
  const handle=await client.prepare('model=None',{mutableData:['observed']});
  await client.updateData(handle,{observed:[1,2,3]});
  assert.ok(codes.some(code=>code.includes('.update_data(json.loads(')));
  await client.sample(handle,{maxDepth:5,jitter:.2,initRetries:7});
  const call=calls.find(x=>x.kind==='sample');
  assert.equal(call.options.maxDepth,5);assert.equal(call.options.jitter,.2);assert.equal(call.options.initRetries,7);
  assert.equal(rt.compiles,1);
  client.busy=true;
  await assert.rejects(client.updateData(handle,{observed:[4,5,6]}),/already active/);
  client.busy=false; await client.release(handle);
  await assert.rejects(client.updateData(handle,{observed:[4,5,6]}),/invalid or expired/);
});
test('stream mode skips Python result construction and rejects afterSample', async t => {
  const {client,codes,calls}=runtime(t);client.fetch=async()=>'';
  const handle=await client.prepare('model=None');const before=codes.length;
  await client.sample(handle,{resultFormat:'stream'});
  assert.equal(codes.length,before);
  assert.equal(calls.find(x=>x.kind==='sample').options.resultFormat,'stream');
  await assert.rejects(client.sample(handle,{resultFormat:'stream',afterSample:'print(idata)'}),/afterSample/);
});
