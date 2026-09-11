/** Worker-owned runtime. No allocations are placed manually in sampler memory. */
export class TapewasmRuntime {
  constructor() {this.models = new Map(); this.nextId = 0;}
  async initialize({moduleUrl, wasmUrl}) {
    if (!this.initialization) this.initialization = (async () => {
      const api = await import(moduleUrl);
      await api.default({module_or_path: new URL(wasmUrl)});
      for (const name of ['AotSampler', 'sharedMemory', 'setAotExports'])
        if (typeof api[name] !== 'function') throw Error(`tapewasm module is missing ${name}`);
      this.api = api;
    })().catch(error => {this.initialization = null; throw error;});
    return this.initialization;
  }
  async fetch(url, type) {
    const r = await fetch(url); if (!r.ok) throw Error(`Could not load ${url}: ${r.status}`);
    return r[type]();
  }
  async prepare(artifact) {
    const start = performance.now();
    const meta = await this.fetch(artifact.metadataUrl, 'json');
    const {nParams, scratchInit, layoutId, paramNames, initialPoint} = meta;
    if (!Number.isInteger(nParams) || nParams < 1 || !Number.isInteger(layoutId) || layoutId < 0 || layoutId > 0xffffffff)
      throw Error('Invalid tapewasm nParams or layoutId');
    const finite = a => Array.isArray(a) && a.every(Number.isFinite);
    if (!finite(initialPoint) || initialPoint.length !== nParams || !finite(scratchInit)) throw Error('Invalid tapewasm initialPoint or scratchInit');
    if (!Array.isArray(paramNames) || paramNames.length !== nParams || !paramNames.every(x => typeof x === 'string')) throw Error('paramNames must name each unconstrained coordinate');
    const bytes = await this.fetch(artifact.wasmUrl, 'arrayBuffer');
    const module = await WebAssembly.compile(bytes);
    for (const item of WebAssembly.Module.imports(module)) {
      if (!(item.module === 'tapewasm' && item.name === 'memory' && item.kind === 'memory') &&
          !(item.module === 'Math' && item.kind === 'function' && ['exp','log','pow','sin','cos','tan','asin','acos','atan'].includes(item.name)))
        throw Error(`Unsupported model import ${item.module}.${item.name}`);
    }
    const instance = await WebAssembly.instantiate(module, {tapewasm: {memory: this.api.sharedMemory()}, Math});
    if (typeof instance.exports.log_prob_grad !== 'function' ||
        !(instance.exports.tapewasm_layout_id instanceof WebAssembly.Global) ||
        (instance.exports.tapewasm_layout_id.value >>> 0) !== layoutId)
      throw Error('Model WASM and metadata layout do not match');
    const id = ++this.nextId;
    this.models.set(id, {meta, exports: instance.exports});
    return {id, nParams, paramNames: [...paramNames], load_seconds: (performance.now() - start) / 1000};
  }
  release(id) {if (!this.models.delete(id)) throw Error('Unknown tapewasm model');}
  sample(id, {chains, tune, draws, seed, initialPositions}) {
    const model = this.models.get(id); if (!model) throw Error('Unknown tapewasm model');
    const {meta} = model;
    const starts = initialPositions ?? Array.from({length: chains}, () => [...meta.initialPoint]);
    if (!Array.isArray(starts) || starts.length !== chains || starts.some(p =>
      !Array.isArray(p) || p.length !== meta.nParams || !p.every(Number.isFinite)))
      throw Error('initialPositions must contain one finite unconstrained vector per chain');
    this.api.setAotExports(model.exports);
    const started = performance.now();
    const samples = new Float64Array(chains * draws * meta.nParams);
    for (let chain = 0; chain < chains; chain++) {
      const sampler = new this.api.AotSampler(meta.nParams, new Float64Array(meta.scratchInit), meta.layoutId, meta.paramNames);
      try {
        const flat = sampler.sample(new Float64Array(starts[chain]), tune, draws, BigInt(seed + chain));
        if (flat.length !== (tune + draws) * meta.nParams || !flat.every(Number.isFinite)) throw Error('tapewasm returned invalid draws');
        samples.set(flat.subarray(tune * meta.nParams), chain * draws * meta.nParams);
      } finally {sampler.free();}
    }
    return {samples, sampling_seconds: (performance.now() - started) / 1000, initial_positions: starts};
  }
}
