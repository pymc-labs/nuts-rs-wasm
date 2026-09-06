/** Experimental stateless WASM caller; NOT a linked Rust sampler.
 * Keep the BrowserModel and worker alive, and pass only pointers owned by that
 * runtime. No allocator is introduced. No JavaScript wrapper may replace the
 * two native WASM callback exports if testing direct cross-module calls.
 */
export async function createDirectCaller(bytes, runtime, model) {
  const memory = runtime.wasmMemory ?? runtime.asm?.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw Error('Runtime memory is required');
  const entry = pointer => runtime.wasmTable?.get(pointer) ?? runtime.getWasmTableEntry?.(pointer);
  const density = entry(model.callback_pointer);
  const expand = entry(model.expand_pointer);
  if (!density || !expand) throw Error('Native runtime callback table entries are required');
  const {instance} = await WebAssembly.instantiate(bytes, {runtime: {memory, density, expand}});
  let active = true;
  const checked = fn => (...args) => {
    if (!active) throw Error('Direct caller released or worker terminated');
    return fn(...args);
  };
  return {
    density: checked(instance.exports.density),
    expand: checked(instance.exports.expand),
    repeatDensity: checked(instance.exports.repeat_density),
    close() {active = false;},
  };
}
