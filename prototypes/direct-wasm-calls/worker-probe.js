// Experimental runtime bootstrap only. Never installed by production builds.
importScripts('/runtime/nuts-worker-loader.js');
async function runDirectProbe(model, {analytic = true, iterations = 20000} = {}) {
  const {createDirectCaller} = await import('/direct-prototype/direct.mjs');
  const {createModelBridge} = await import('/nuts/bridge-memory.mjs');
  const bytes = await (await fetch('/direct-prototype/direct.wasm')).arrayBuffer();
  const direct = await createDirectCaller(bytes, Module, model);
  const n=model.initial.length, ne=model.expanded_size;
  const x=64, g=x+n*8+64, out=g+n*8+64;
  const memory = new WebAssembly.Memory({initial:Math.ceil((out+ne*8+64)/65536)});
  const plain=createModelBridge(Module,model,()=>memory,'none');
  const cached=createModelBridge(Module,model,()=>memory,'views');
  const near=(a,b,label)=>{if(!Number.isFinite(a)||!Number.isFinite(b)||Math.abs(a-b)>1e-10*(1+Math.abs(b)))throw Error(`${label}: ${a} != ${b}`);};
  const compare=(a,b,label)=>{if(a.length!==b.length)throw Error(`${label} shape`);a.forEach((v,i)=>near(v,b[i],label));};
  const read=(pointer,size)=>Array.from(new Float64Array(Module.wasmMemory.buffer,pointer,size));
  const findings=[];
  try {
    for(const shift of [0,.2,-.15]) {
      const point=model.initial.map((v,i)=>v+shift*(i?-.5:1));
      new Float64Array(memory.buffer,x,n).set(point);
      const baseline=plain.model_logp(x,g,n);
      const baselineGradient=Array.from(new Float64Array(memory.buffer,g,n));
      if(plain.model_expand(x,out,ne))throw Error('Baseline expansion failed');
      const baselineExpanded=Array.from(new Float64Array(memory.buffer,out,ne));
      near(cached.model_logp(x,g,n),baseline,'cached density');
      if(cached.model_expand(x,out,ne))throw Error('Cached expansion failed');
      new Float64Array(Module.wasmMemory.buffer,model.x_pointer,n).set(point);
      near(direct.density(model.x_pointer,model.g_pointer),baseline,'direct density');
      compare(read(model.g_pointer,n),baselineGradient,'direct gradient');
      if(direct.expand(model.x_pointer,model.expanded_pointer))throw Error('Direct expansion failed');
      compare(read(model.expanded_pointer,ne),baselineExpanded,'direct expansion');
      if(analytic) {
        const scale=Math.exp(point[1]);
        compare(baselineGradient,[-point[0],1-scale*scale],'analytic gradient');
        compare(baselineExpanded,[point[0],scale,point[0]+scale*scale],'analytic transform and deterministic');
      }
      findings.push({point,logp:baseline,gradient:baselineGradient,expanded:baselineExpanded});
    }
    new Float64Array(Module.wasmMemory.buffer,model.x_pointer,n).set(model.initial);
    new Float64Array(memory.buffer,x,n).set(model.initial);
    const native=Module.wasmTable.get(model.callback_pointer);
    const expand=Module.wasmTable.get(model.expand_pointer);
    const variants={
      js_uncached_with_copies:(xp,gp)=>plain.model_logp(xp,gp,n),
      js_cached_with_copies:(xp,gp)=>cached.model_logp(xp,gp,n),
      js_shared_buffers:(xp,gp)=>native(xp,gp),
      wasm_direct_shared_buffers:native,
    };
    const timings={},runs=5;
    for(const [name,density] of Object.entries(variants)) {
      const {instance}=await WebAssembly.instantiate(bytes,{runtime:{memory:Module.wasmMemory,density,expand}});
      const copy=name.includes('copies');const xp=copy?x:model.x_pointer,gp=copy?g:model.g_pointer;
      instance.exports.repeat_density(xp,gp,1000);
      timings[name]=[];
      for(let run=0;run<runs;run++) {
        const started=performance.now();const sum=instance.exports.repeat_density(xp,gp,iterations);
        timings[name].push(performance.now()-started);
        near(sum/iterations,findings[0].logp,'repeated density');
      }
    }
    return {kind:'actual_numba_direct_callback_probe',findings,iterations,runs,timings,
      runtime_memory_bytes:Module.wasmMemory.buffer.byteLength,
      note:'Direct scalar WASM caller, not direct Rust NUTS. Arrow and sampling remain on the existing bridge.'};
  } finally {
    new Float64Array(Module.wasmMemory.buffer,model.x_pointer,n).set(model.initial);
    direct.close();
  }
}
self.nutsDirectProbe = {check(model, options) {
  runDirectProbe(model, options).then(
    result=>self.postMessage({nutsDirectProbe:'result',result}),
    error=>self.postMessage({nutsDirectProbe:'error',message:String(error.stack||error)})
  );
}};
