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
