import {TapewasmRuntime} from './tapewasm-runtime.mjs';
const runtime = new TapewasmRuntime();
self.onmessage = async ({data: m}) => {
  try {
    await runtime.initialize(m.config);
    let result;
    if (m.method === 'prepare') result = await runtime.prepare(m.artifact);
    else if (m.method === 'sample') result = runtime.sample(m.modelId, m.options);
    else if (m.method === 'release') result = runtime.release(m.modelId);
    else if (m.method !== 'initialize') throw Error('Unknown tapewasm method');
    self.postMessage({id: m.id, result}, result?.samples ? [result.samples.buffer] : []);
  } catch (error) {self.postMessage({id: m.id, error: error.message ?? String(error)});}
};
