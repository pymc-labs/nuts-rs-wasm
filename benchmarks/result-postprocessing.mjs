// Reproducible synthetic postprocessing benchmark: conversion, actual worker
// transfer, local binary/JSON ingestion and xarray construction. No sampler cost.
// PYTHON=/path/to/python node benchmarks/result-postprocessing.mjs
import {Worker, isMainThread, parentPort} from 'node:worker_threads';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {compatibilityResult, stageWorkerResult} from '../bridge.mjs';

if (!isMainThread) {
  parentPort.once('message', result => parentPort.postMessage({received:result.shape, memory:process.memoryUsage(), peakRssBytes:process.resourceUsage().maxRSS*1024}));
} else if (!process.argv[2]) {
  for (const size of ['small','large']) for (const mode of ['compatibility','binary']) {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url),size,mode], {encoding:'utf8'});
    if (run.status) throw Error(run.stderr);
    process.stdout.write(run.stdout);
  }
} else {
  const [size, mode] = process.argv.slice(2);
  const shape = size === 'small' ? [2,500,8] : [4,5000,64];
  const [chains,draws,width] = shape;
  const directory = mkdtempSync(join(tmpdir(),'nuts-postprocessing-'));
  const result = {result_format:'binary',shape,unconstrained_width:width,
    expanded_samples:Float64Array.from({length:chains*draws*width},(_,i)=>Math.sin(i)),
    stats:Float64Array.from({length:chains*draws*3},(_,i)=>i%3===0?0:i%3===1?7:.1),
    expanded_layout:[{name:'x',size:width,shape:[width],dims:['parameter']}],
    coords:{parameter:Array.from({length:width},(_,i)=>`p${i}`)},traces:[]};
  const start = performance.now();
  let path, output;
  if (mode === 'binary') {
    path = stageWorkerResult(result,{mkdir:mkdirSync,writeFile:writeFileSync},join(directory,'result'));
    output = result;
  } else {
    output = compatibilityResult(result);
    path = join(directory,'result.json');
    writeFileSync(path,JSON.stringify(output));
  }
  const prepared = performance.now();
  const worker = new Worker(new URL(import.meta.url));
  const ready = new Promise(resolve=>worker.once('online',resolve));
  await ready;
  const transferStart = performance.now();
  const received = new Promise(resolve=>worker.once('message',resolve));
  worker.postMessage(output, mode === 'binary'?[output.expanded_samples.buffer,output.stats.buffer]:[]);
  const receivedInfo = await received;
  const transferMs = performance.now()-transferStart;
  await worker.terminate();
  const python = spawnSync(process.env.PYTHON ?? 'python3', ['-c', `
import json, time, resource, sys
from results import load_worker_result, to_inference_data
start=time.perf_counter()
result=load_worker_result(sys.argv[1]) if sys.argv[2]=='binary' else json.load(open(sys.argv[1]))
loaded=time.perf_counter()
idata=to_inference_data(result)
print(json.dumps(dict(python_load_ms=(loaded-start)*1000,xarray_ms=(time.perf_counter()-loaded)*1000,python_peak_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024))))
`,path,mode], {encoding:'utf8',cwd:new URL('../',import.meta.url)});
  try {
    if (python.status) throw Error(python.stderr);
    const py = JSON.parse(python.stdout);
    console.log(JSON.stringify({size,mode,shape,prepare_ms:prepared-start,transfer_ms:transferMs,
      postprocessing_ms:prepared-start+transferMs+py.python_load_ms+py.xarray_ms,
      node_rss_after_transfer:receivedInfo.memory.rss,node_peak_rss_bytes:receivedInfo.peakRssBytes,...py}));
  } finally {rmSync(directory,{recursive:true,force:true});}
}
