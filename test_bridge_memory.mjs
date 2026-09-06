import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createModelBridge} from './bridge-memory.mjs';
import {sample} from './bridge.mjs';

test('cached views follow both memory buffers, pointer/length changes and growth inside callbacks', () => {
  for (const cache of ['none', 'callbacks', 'views']) {
    const rust = new WebAssembly.Memory({initial: 1});
    const memory = new WebAssembly.Memory({initial: 1});
    const model = {initial: [1, 2], x_pointer: 0, g_pointer: 64,
      expanded_pointer: 128, callback_pointer: 1, expand_pointer: 2};
    let grow = false, lookups = 0, error = 0;
    const runtime = {wasmMemory: memory, wasmTable: {get(pointer) {
      lookups++;
      return (xp, out) => {
        if (grow) {rust.grow(1); memory.grow(1);}
        const n = model.initial.length;
        const x = new Float64Array(memory.buffer, xp, n);
        new Float64Array(memory.buffer, out, n).set(Array.from(x, v => pointer === 1 ? -v : 2*v));
        return pointer === 1 ? -Array.from(x).reduce((s, v) => s + v*v/2, 0) : error;
      };
    }}};
    const bridge = createModelBridge(runtime, model, () => rust, cache);
    for (let iteration = 0; iteration < 12; iteration++) {
      // Change the Rust allocations and occasionally the model buffer layout.
      const n = iteration % 3 + 1;
      model.initial = Array.from({length: n}, (_, j) => j + iteration + 1);
      model.x_pointer = iteration % 2 ? 256 : 0;
      model.g_pointer = iteration % 2 ? 320 : 64;
      model.expanded_pointer = iteration % 2 ? 384 : 128;
      const xp = 512 + iteration * 64, gp = 2048 + iteration * 64, out = 4096 + iteration * 64;
      if (iteration % 3 === 0) {rust.grow(1); memory.grow(1);}
      grow = iteration % 4 === 0;
      new Float64Array(rust.buffer, xp, n).set(model.initial);
      assert.equal(bridge.model_logp(xp, gp, n), -model.initial.reduce((s, v) => s + v*v/2, 0));
      assert.deepEqual(Array.from(new Float64Array(rust.buffer, gp, n)), model.initial.map(v => -v));
      assert.equal(bridge.model_expand(xp, out, n), 0);
      assert.deepEqual(Array.from(new Float64Array(rust.buffer, out, n)), model.initial.map(v => 2*v));
    }
    error = 7;
    assert.equal(bridge.model_expand(512, 4096, model.initial.length), 7);
    assert.equal(lookups, cache === 'none' ? 25 : 2);
  }
});

test('identity expansion handles changing sampler views', () => {
  const memory = new WebAssembly.Memory({initial: 1});
  const bridge = createModelBridge({wasmTable: {get: () => () => 0}}, {callback_pointer: 1}, () => memory);
  for (const offset of [0, 128, 0]) {
    memory.grow(1);
    new Float64Array(memory.buffer, offset, 2).set([1, 2]);
    assert.equal(bridge.model_expand(offset, 256, 2), 0);
    assert.deepEqual(Array.from(new Float64Array(memory.buffer, 256, 2)), [1, 2]);
  }
});

test('real sampler preserves samples, stats, streams and Arrow; repeated fits resolve new callbacks', async () => {
  const bytes = await readFile(process.argv[2] ?? new URL('./adapter/target/wasm32-unknown-unknown/release/nuts_browser_adapter.wasm', import.meta.url));
  const memory = new WebAssembly.Memory({initial: 1});
  let lookups = 0, densityCalls = 0, expansionCalls = 0;
  const runtime = {wasmMemory: memory, wasmTable: {get(pointer) {
    lookups++;
    const scale = pointer >= 3 ? 2 : 1;
    return (xp, out) => {
      if (pointer % 2) densityCalls++; else expansionCalls++;
      if ((densityCalls + expansionCalls) % 37 === 0) memory.grow(1);
      const x = new Float64Array(memory.buffer, xp, 2);
      new Float64Array(memory.buffer, out, 2).set(Array.from(x, v => pointer % 2 ? -v/scale : 2*v));
      return pointer % 2 ? -(x[0]**2 + x[1]**2)/(2*scale) : 0;
    };
  }}};
  const model = {initial: [0.1, 0.2], x_pointer: 0, g_pointer: 16,
    expanded_pointer: 32, callback_pointer: 1, expand_pointer: 2, layout: []};
  for (const pointer of [1, 3]) {
    model.callback_pointer = pointer; model.expand_pointer = pointer + 1;
    const outputs = [], streams = [];
    for (const bridgeCache of ['none', 'callbacks', 'views']) {
      lookups = densityCalls = expansionCalls = 0;
      const batches = [];
      const result = await sample({bytes, runtime, model, bridgeCache, tune: 21, draws: 23,
        onSamples: batch => batches.push(batch)});
      assert.equal(expansionCalls, 46);
      assert.equal(lookups, bridgeCache === 'none' ? densityCalls + expansionCalls : 2);
      const {sampling_seconds, ...stable} = result;
      outputs.push(stable); streams.push(batches);
    }
    for (let i = 1; i < outputs.length; i++) {
      assert.deepEqual(outputs[0], outputs[i]);
      assert.deepEqual(streams[0], streams[i]);
    }
  }
});
