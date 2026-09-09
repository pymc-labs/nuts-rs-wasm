"""Sample directly inside a Xeus-Python notebook kernel (no iframe or worker)."""

import json
import time

from compile_model import compile_browser_model
from results import load_worker_result, to_inference_data


async def sample(
    model,
    *,
    var_names=None,
    asset_url="https://pymc-labs.github.io/nuts-rs-wasm/nuts/",
    **options,
):
    """Return an xarray DataTree; execute in the current Xeus WebAssembly kernel.

    ``asset_url`` must host the matching bridge modules and Rust WASM binary.
    Options use the JavaScript sampler's names (e.g. targetAccept, maxDepth).
    The synchronous Rust fit occupies this kernel until complete.
    """
    import pyjs

    from notebook_setup import ensure_setuptools

    await ensure_setuptools()
    started = time.perf_counter()
    compiled = compile_browser_model(model, var_names=var_names)
    compile_seconds = time.perf_counter() - started

    # The public PyJS view supplies the current Python memory, without requiring
    # a patched Xeus loader. Recreate it only after WASM memory growth detaches it.
    def memory_view():
        return pyjs.buffer_to_js_typed_array(compiled.scratch, view=True)

    run = pyjs.js.Function(
        "base",
        "config",
        "options",
        "view",
        "refresh",
        """
      return (async () => {
        const {sample, stageWorkerResult} = await import(new URL('bridge.mjs', base));
        const response = await fetch(new URL('nuts_browser_adapter.wasm', base));
        if (!response.ok) throw Error('Could not load the Rust sampler');
        let buffer = view.buffer;
        const memory = {get buffer() {
          if (!buffer.byteLength) buffer = refresh().buffer;
          return buffer;
        }};
        const result = await sample({bytes: await response.arrayBuffer(),
          runtime: {wasmMemory: memory, wasmTable: Module.wasmTable},
          model: JSON.parse(config), ...JSON.parse(options), resultFormat: 'binary'});
        const directory = '/tmp/nuts-notebook-' + crypto.randomUUID();
        const manifest = stageWorkerResult(result, Module.FS, directory);
        return JSON.stringify({manifest, seconds: result.sampling_seconds});
      })();
    """,
    )
    with pyjs.callable_context(memory_view) as refresh:
        output = json.loads(
            str(
                await run(
                    asset_url,
                    json.dumps(compiled.config()),
                    json.dumps(options),
                    memory_view(),
                    refresh,
                )
            )
        )
    result = load_worker_result(output["manifest"])
    idata = to_inference_data(result)
    idata.attrs.update(
        compile_seconds=compile_seconds, sampling_seconds=output["seconds"]
    )
    return idata
