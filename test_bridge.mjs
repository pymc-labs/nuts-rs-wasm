// Exercise the actual Rust WASM module and JS memory bridge with a Gaussian.
// A real browser Numba function-table callback additionally needs a Xeus runtime.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {sample} from './bridge.mjs';
const bytes = await readFile(process.argv[2] ??
  new URL('./adapter/target/wasm32-unknown-unknown/release/nuts_browser_adapter.wasm', import.meta.url));
const memory = new WebAssembly.Memory({initial: 1});
let calls = 0, progress = 0, streamed = 0;
const runtime = {wasmMemory: memory, wasmTable: {get(pointer) {
  assert.equal(pointer, 7);
  return (xp, gp) => {
    // Exercise view invalidation when Emscripten grows memory during a callback.
    if (++calls === 1) memory.grow(1);
    const x = new Float64Array(memory.buffer, xp, 2);
    const g = new Float64Array(memory.buffer, gp, 2);
    g[0] = -x[0]; g[1] = -x[1];
    return -(x[0] ** 2 + x[1] ** 2) / 2;
  };
}}};
const model = {initial: [0.1, 0.2], x_pointer: 0, g_pointer: 16,
  callback_pointer: 7, layout: []};
const options = {bytes, runtime, model, onProgress: () => progress++, onSamples: b => {streamed += b.draws; assert.equal(b.values.length, b.draws * 2);}};
const result = await sample(options);
assert.equal(result.divergences, 0);
assert.equal(result.samples.length, 2);
assert.ok(result.samples.every(c => c.length === 500 && c.every(x => x.length === 2)));
assert.equal(calls, result.logp_evaluations);
assert.ok(progress > 0);
for (let j = 0; j < 2; j++) {
  const xs = result.samples.flat().map(x => x[j]);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const second = xs.reduce((a, b) => a + b * b, 0) / xs.length;
  assert.ok(Math.abs(mean) < 0.2, `Gaussian mean ${mean}`);
  assert.ok(Math.abs(second - 1) < 0.25, `Gaussian second moment ${second}`);
}
await assert.rejects(sample({...options, draws: 0}), /Invalid draws/);
await assert.rejects(sample({...options, model: {...model, initial: [NaN, 0]}}), /finite/);
const badRuntime = {...runtime, wasmTable: {get: () => () => NaN}};
await assert.rejects(sample({...options, runtime: badRuntime}));
console.log('WASM Gaussian posterior, memory growth, progress and error handling passed');

assert.equal(streamed, 1000);
assert.equal(result.traces.length, 4);
for (const trace of result.traces) {
  assert.ok(trace.bytes.length > 1000);
  if (process.env.ARROW_TEST_DIR) await writeFile(`${process.env.ARROW_TEST_DIR}/${trace.chain}-${trace.group}.arrow`, trace.bytes);
}

// Warmup must never call deterministic expansion, including around 10-draw batches.
for (const tune of [1, 9, 10, 11]) {
  for (const draws of [1, 9, 10, 11]) {
    let expansions = 0;
    const events = [], batches = [];
    const countedRuntime = {...runtime, wasmTable: {get(pointer) {
      if (pointer === 8) return (xp, out) => {
        expansions++;
        const x = new Float64Array(memory.buffer, xp, 2);
        new Float64Array(memory.buffer, out, 2).set([x[0] * 2, x[1] * 2]);
        return 0;
      };
      return runtime.wasmTable.get(pointer);
    }}};
    const countResult = await sample({...options, tune, draws,
      runtime: countedRuntime,
      model: {...model, expand_pointer: 8, expanded_pointer: 32},
      onProgress: event => events.push(event), onSamples: batch => batches.push(batch)});
    assert.equal(expansions, 2 * draws);
    assert.equal(batches.reduce((sum, b) => sum + b.draws, 0), 2 * draws);
    for (let chain = 0; chain < 2; chain++) {
      const chainBatches = batches.filter(b => b.chain === chain);
      assert.deepEqual(chainBatches.map(b => b.start), draws > 10 ? [0, 10] : [0]);
      assert.deepEqual(events.filter(e => e.chain === chain).map(e => [e.index, e.tuning]),
        Array.from({length: tune + draws}, (_, i) => i)
          .filter(i => i % 10 === 0 || i === tune + draws - 1)
          .map(i => [i, i < tune]));
      assert.deepEqual(countResult.expanded_samples[chain],
        countResult.samples[chain].map(x => x.map(v => 2 * v)));
    }
  }
}
console.log('Warmup expansion counts, short tuning, batch boundaries and progress passed');
