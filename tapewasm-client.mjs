/** Experimental client for precompiled, trusted tapewasm model artifacts. */
const abortError = () => new DOMException('Sampling cancelled', 'AbortError');
const unsupported = (options, allowed) => {
  for (const key of Object.keys(options)) if (!allowed.includes(key))
    throw Error(`tapewasm does not support option ${key}`);
};
export class TapewasmSampler {
  constructor({moduleUrl, wasmUrl, workerUrl = new URL('./tapewasm-worker.mjs', import.meta.url), loadTimeout = 300000}) {
    if (!moduleUrl || !wasmUrl) throw Error('tapewasm requires moduleUrl and wasmUrl for the external sampler');
    const base = globalThis.location?.href ?? import.meta.url;
    this.config = {moduleUrl: new URL(moduleUrl, base).href, wasmUrl: new URL(wasmUrl, base).href};
    this.workerUrl = workerUrl; this.loadTimeout = loadTimeout;
    this.worker = null; this.pending = new Map(); this.models = new WeakMap(); this.epoch = 0;
    this.busy = false; this.nextId = 0;
    this.capabilities = Object.freeze({precompiled: true, python: false, expansion: false,
      mutableData: false, streaming: false, arrow: false});
  }
  request(method, payload = {}, timeout = 0) {
    if (!this.worker) {
      const worker = new Worker(this.workerUrl, {type: 'module'});
      this.worker = worker;
      worker.onmessage = ({data}) => {
        if (worker !== this.worker) return;
        const p = this.pending.get(data.id); if (!p) return;
        this.pending.delete(data.id); clearTimeout(p.timer);
        if (data.error) p.reject(Error(data.error)); else p.resolve(data.result);
      };
      worker.onerror = e => {if (worker === this.worker) this.cancel(Error(e.message || 'tapewasm worker failed'));};
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = timeout ? setTimeout(() => this.cancel(Error('tapewasm loading timed out')), timeout) : null;
      this.pending.set(id, {resolve, reject, timer});
      try {this.worker.postMessage({id, method, config: this.config, ...payload});}
      catch (error) {this.pending.delete(id); clearTimeout(timer); reject(error);}
    });
  }
  async operation(options, action) {
    if (this.busy) throw Error('A sampling run is already active');
    if (options.signal?.aborted) throw abortError();
    this.busy = true;
    const epoch = this.epoch;
    const abort = () => this.cancel();
    options.signal?.addEventListener('abort', abort, {once: true});
    const check = () => {if (epoch !== this.epoch || options.signal?.aborted) throw abortError();};
    try {return await action(check);}
    finally {options.signal?.removeEventListener('abort', abort); if (epoch === this.epoch) this.busy = false;}
  }
  initialize() {return this.operation({}, () => this.request('initialize', {}, this.loadTimeout));}
  async prepareModel(source, check) {
    if (!source || typeof source !== 'object' || !source.wasmUrl || !source.metadataUrl)
      throw Error('tapewasm requires {wasmUrl, metadataUrl}; Python source is not supported');
    const base = globalThis.location?.href ?? import.meta.url;
    const artifact = {wasmUrl: new URL(source.wasmUrl, base).href, metadataUrl: new URL(source.metadataUrl, base).href};
    const state = await this.request('prepare', {artifact}, this.loadTimeout); check();
    const handle = Object.freeze({id: state.id, compile_seconds: 0});
    this.models.set(handle, {epoch: this.epoch, ...state});
    return handle;
  }
  prepare(source, options = {}) {
    return this.operation(options, check => {
      unsupported(options, ['signal']); return this.prepareModel(source, check);
    });
  }
  compile(source, options = {}) {return this.prepare(source, options);}
  state(handle) {
    const state = this.models.get(handle);
    if (!state || state.epoch !== this.epoch) throw Error('Compiled model handle is invalid or expired');
    return state;
  }
  release(handle) {
    return this.operation({}, async () => {
      const state = this.state(handle); await this.request('release', {modelId: state.id}); this.models.delete(handle);
    });
  }
  sample(source, options = {}) {
    return this.operation(options, async check => {
      unsupported(options, ['signal', 'chains', 'tune', 'draws', 'seed', 'resultFormat', 'initialPositions']);
      const {chains = 2, tune = 750, draws = 500, seed = 42, resultFormat = 'compatibility', initialPositions} = options;
      for (const [key, value, max] of [['chains', chains, 1000], ['tune', tune, 0xffffffff], ['draws', draws, 0xffffffff]])
        if (!Number.isInteger(value) || value < 1 || value > max) throw Error(`${key} must be a positive integer <= ${max}`);
      if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isSafeInteger(seed + chains - 1)) throw Error('seed must be a nonnegative safe integer');
      if (!['compatibility', 'binary'].includes(resultFormat)) throw Error('tapewasm resultFormat must be compatibility or binary');
      const reused = this.models.has(source);
      // Handles from other clients must not be mistaken for model artifacts.
      if (!reused && source?.id) throw Error('Compiled model handle belongs to another sampler or is invalid');
      const handle = reused ? source : await this.prepareModel(source, check);
      const state = this.state(handle);
      try {
        const result = await this.request('sample', {modelId: state.id, options: {chains, tune, draws, seed, initialPositions}}); check();
        const flat = result.samples;
        if (resultFormat === 'compatibility') result.samples = Array.from({length: chains}, (_, c) =>
          Array.from({length: draws}, (_, d) => Array.from(flat.subarray((c * draws + d) * state.nParams, (c * draws + d + 1) * state.nParams))));
        return {...result, backend: 'tapewasm', space: 'unconstrained', compile_seconds: 0,
          load_seconds: reused ? 0 : state.load_seconds, unconstrained_width: state.nParams,
          unconstrained_shape: [chains, draws, state.nParams], param_names: state.paramNames, traces: []};
      } finally {
        if (!reused && this.epoch === state.epoch) {
          await this.request('release', {modelId: state.id}); this.models.delete(handle);
        }
      }
    });
  }
  execute() {return Promise.reject(Error('tapewasm does not execute Python'));}
  updateData() {return Promise.reject(Error('tapewasm artifacts have fixed data; compile and prepare a new artifact'));}
  cancel(error = abortError()) {
    this.epoch++; this.worker?.terminate(); this.worker = null; this.busy = false;
    for (const p of this.pending.values()) {clearTimeout(p.timer); p.reject(error);}
    this.pending.clear();
  }
  close() {this.cancel();}
}
