import {createModelBridge} from '../bridge-memory.mjs';

/** No sampler, compilation or result serialization inside these timed loops. */
export async function benchmarkBridge(bytes, {repetitions = 7} = {}) {
  const {instance} = await WebAssembly.instantiate(bytes);
  const ex = instance.exports;
  const table = new WebAssembly.Table({element: 'anyfunc', initial: 3});
  table.set(1, ex.logp); table.set(2, ex.expand);
  const runtime = {wasmMemory: ex.memory, wasmTable: table};
  const rust = new WebAssembly.Memory({initial: 2});
  const rows = [];
  for (const width of [2, 1024]) {
    ex.set_width(width);
    const initial = Array.from({length: width}, (_, i) => (i + 1) / width);
    const model = {initial, callback_pointer: 1, expand_pointer: 2,
      x_pointer: 0, g_pointer: 16384, expanded_pointer: 32768};
    for (const pointer of [0, 16384]) new Float64Array(rust.buffer, pointer, width).set(initial);
    const expected = -initial.reduce((sum, x) => sum + x*x/2, 0);
    const iterations = width === 2 ? 200_000 : 20_000;
    const modes = ['none', 'callbacks', 'views'];
    const bridges = Object.fromEntries(modes.map(mode => [mode, createModelBridge(runtime, model, () => rust, mode)]));
    for (const operation of ['logp', 'expand']) {
      const run = (mode, count) => {
        const bridge = bridges[mode];
        let checksum = 0;
        const start = performance.now();
        for (let i = 0; i < count; i++) {
          // Alternate pointers in bounded blocks, as Rust allocations change.
          const pointer = (i >> 5) % 2 ? 16384 : 0;
          checksum += operation === 'logp' ? bridge.model_logp(pointer, 32768, width)
            : bridge.model_expand(pointer, 32768, width);
        }
        const milliseconds = performance.now() - start;
        if (operation === 'logp' && Math.abs(checksum - count*expected) > 1e-5 * Math.abs(checksum)) throw Error('Density mismatch');
        const output = new Float64Array(rust.buffer, 32768, width);
        if (!output.every((v, i) => v === (operation === 'logp' ? -initial[i] : 2*initial[i]))) throw Error('Output mismatch');
        return milliseconds;
      };
      for (const mode of modes) run(mode, iterations); // Untimed warmup for each mode.
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const rotated = [...modes.slice(repetition % 3), ...modes.slice(0, repetition % 3)];
        for (const mode of rotated) rows.push({width, operation, mode, repetition, iterations,
          milliseconds: run(mode, iterations)});
      }
    }
  }
  const summary = [];
  for (const width of [2, 1024]) for (const operation of ['logp', 'expand']) {
    for (const mode of ['none', 'callbacks', 'views']) {
      const selected = rows.filter(r => r.width === width && r.operation === operation && r.mode === mode);
      const ns = selected.map(r => r.milliseconds * 1e6 / r.iterations).sort((a, b) => a-b);
      summary.push({width, operation, mode, median_ns_per_call: ns[Math.floor(ns.length/2)],
        min_ns_per_call: ns[0], max_ns_per_call: ns.at(-1)});
    }
  }
  return {generated_at: new Date().toISOString(),
    runtime: typeof process === 'undefined' ? {user_agent: navigator.userAgent} : {node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch},
    description: 'Cheap actual WASM Gaussian and expansion callbacks; bridge calls only, no compilation/sampler/serialization; one full warmup batch per mode; rotating measurement order.',
    rows, summary};
}

if (typeof process !== 'undefined' && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const {readFile, writeFile} = await import('node:fs/promises');
  const bytes = await readFile(new URL('./bridge-callback.wasm', import.meta.url));
  const result = await benchmarkBridge(bytes);
  await writeFile(process.argv[2] ?? new URL('./bridge-cache-node.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.table(result.summary);
}
