import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDirectCaller} from './direct.mjs';
const load = name => readFile(new URL(name, import.meta.url));
const directBytes = await load('direct.wasm'), cheapBytes = await load('cheap-callback.wasm');
const memory = new WebAssembly.Memory({initial: 1, maximum: 8});
const rustMemory = new WebAssembly.Memory({initial: 1, maximum: 8});
const {instance: callback} = await WebAssembly.instantiate(cheapBytes, {runtime: {memory}});
// Fixture runtime owns the buffers at 64/128/192; real runtime callers must
// obtain addresses from BrowserModel, never reserve arbitrary fixed offsets.
const xp = 64, gp = 128, op = 192;
const model = {callback_pointer: 1, expand_pointer: 2};
const runtime = {wasmMemory: memory, getWasmTableEntry: p => p === 1 ? callback.exports.density : callback.exports.expand};
new Float64Array(memory.buffer, xp, 2).set([2, -3]);
new Float64Array(rustMemory.buffer, xp, 2).set([2, -3]);
const direct = await createDirectCaller(directBytes, runtime, model);
assert.equal(direct.density(xp, gp), -6.5);
assert.deepEqual([...new Float64Array(memory.buffer, gp, 2)], [-2, 3]);
assert.equal(direct.expand(xp, op), 0);
assert.deepEqual([...new Float64Array(memory.buffer, op, 2)], [4, -2]);
assert.equal(direct.repeatDensity(xp, gp, 17), -110.5);
// Both memories may grow; direct calls use offsets, not detached JS views.
memory.grow(1); rustMemory.grow(1);
assert.equal(direct.density(xp, gp), -6.5);
assert.equal(direct.expand(xp, op), 0);
assert.deepEqual([...new Float64Array(memory.buffer, gp, 2)], [-2, 3]);
for (let fit = 0; fit < 3; fit++) assert.equal(direct.repeatDensity(xp, gp, 100), -650);
direct.close();assert.throws(()=>direct.density(xp,gp),/released/);
const uncached = (x,g) => {
  new Float64Array(memory.buffer,xp,2).set(new Float64Array(rustMemory.buffer,x,2));
  const value = runtime.getWasmTableEntry(1)(xp,gp);
  new Float64Array(rustMemory.buffer,g,2).set(new Float64Array(memory.buffer,gp,2));
  return value;
};
let cachedBuffer, cachedRustBuffer, xView, gView, rxView, rgView;
const density = runtime.getWasmTableEntry(1);
const cached = (x,g) => {
  if(cachedBuffer !== memory.buffer || cachedRustBuffer !== rustMemory.buffer) {
    cachedBuffer=memory.buffer;cachedRustBuffer=rustMemory.buffer;
    xView=new Float64Array(cachedBuffer,xp,2);gView=new Float64Array(cachedBuffer,gp,2);
    rxView=new Float64Array(cachedRustBuffer,x,2);rgView=new Float64Array(cachedRustBuffer,g,2);
  }
  xView.set(rxView);const value=density(xp,gp);rgView.set(gView);return value;
};
const callbacks = {
  js_uncached_with_copies: uncached,
  js_cached_with_copies: cached,
  js_shared_buffers: (x,g) => density(x,g),
  wasm_direct_shared_buffers: density,
};
const iterations = Number(process.env.ITERATIONS || 1000000);
const runs = 7, output = {};
for (const [name, fn] of Object.entries(callbacks)) {
  const {instance} = await WebAssembly.instantiate(directBytes, {runtime: {memory, density: fn, expand: callback.exports.expand}});
  const repeat=instance.exports.repeat_density;
  assert.equal(repeat(xp,gp,10000),-65000);
  const timings=[];
  for(let run=0;run<runs;run++) {
    const started=performance.now();assert.equal(repeat(xp,gp,iterations),-6.5*iterations);
    timings.push(performance.now()-started);
  }
  output[name]={milliseconds:timings,median_ms:[...timings].sort((a,b)=>a-b)[Math.floor(runs/2)]};
}
console.log(JSON.stringify({kind:'cheap_actual_wasm_callback_microbenchmark',node:process.version,
  platform:process.platform,arch:process.arch,iterations,runs,
  direct_module_bytes:directBytes.length,fixture_module_bytes:cheapBytes.length,
  fixture_linear_memory_bytes:memory.buffer.byteLength+rustMemory.buffer.byteLength,
  note:'Not Numba or full Rust sampler. Fixed 2D fixture. JS shared versus WASM direct isolates boundary; copy modes also differ in view work.',
  checks:['density','gradient','expansion','both memories grow','repeated calls','explicit invalidation'],results:output},null,2));
