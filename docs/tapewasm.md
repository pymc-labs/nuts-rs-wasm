# Experimental precompiled tapewasm backend

`createSampler({backend: 'tapewasm', ...})` loads a precompiled density and samples
it in a dedicated module worker. No Python, Xeus, Numba, or LLVM is loaded in
this path. Numba remains the default backend.

This first integration supports the precompiled path only. Building a PyMC model
into an artifact remains the responsibility of the separate
[pymcwasm](https://github.com/habakan/pymcwasm) and
[tapewasm](https://github.com/habakan/tapewasm) projects. Dynamic Python model
editing/compilation is not implemented here. There is no automatic fallback.

## Load the optional runtime

The runtime is an explicit external dependency, not included in our adapter
archive. Tested with npm `tapewasm@0.2.0`; use a pinned, self-hosted copy. For a
local checkout, `npm ci --ignore-scripts` installs it as a development dependency
for tests and the example. Production deployments can install it separately and
copy the package's `index.js`, `pkg/`, and license files to their static assets.
No CDN request is made automatically. Host our module worker on the application's
origin and serve external assets with appropriate CORS and WASM MIME headers.

```javascript
import {createSampler} from './client.mjs';

const sampler = createSampler({
  backend: 'tapewasm',
  moduleUrl: '/vendor/tapewasm/index.js',
  wasmUrl: '/vendor/tapewasm/pkg/tapewasm_bg.wasm',
});
const model = await sampler.prepare({
  wasmUrl: '/models/mmm/model.wasm',
  metadataUrl: '/models/mmm/meta.json',
});
const result = await sampler.sample(model, {
  chains: 2, tune: 750, draws: 500, seed: 42,
  resultFormat: 'binary',
});
console.log(result.samples, result.unconstrained_shape, result.param_names);
await sampler.release(model);
sampler.close();
```

`compile()` aliases `prepare()`; it loads an already compiled artifact rather
than compiling Python. Passing the artifact descriptor directly to `sample()`
prepares and releases a temporary handle. Handles belong to one client and
expire after release, cancellation, or worker replacement. Multiple prepared
models can coexist; the worker binds the selected model before each fit.
Operations on one client are sequential. `close()` terminates its worker; a later
operation can start a fresh worker. `loadTimeout` bounds initialization and
artifact loading, but not sampling.

Use an `AbortSignal` to interrupt loading or sampling. Since upstream sampling
is synchronous, abort terminates the worker and invalidates all its handles.
Different clients have separate workers and separate sampler memories.

## Artifact contract

`meta.json` uses upstream's precompiled artifact fields:

- `nParams`: positive number of unconstrained coordinates.
- `paramNames`: one string per coordinate, in parameter-buffer order.
- `initialPoint`: finite starting values in that same order.
- `scratchInit`: finite float64 values, including any staged constants.
- `layoutId`: unsigned 32-bit layout identifier exported by the model.

The model exports `log_prob_grad` and `tapewasm_layout_id`, imports the sampler's
`tapewasm.memory`, and may import standard `Math` functions: exp, log, pow, sin,
cos, tan, asin, acos, atan. Other imports (including a host-provided phi) are
explicitly rejected in this first adapter. Special functions emitted inside the
WASM itself are fine. Memory allocation is owned by upstream `AotSampler`; this
adapter never places buffers at hand-selected addresses in that memory.

These are trusted executable artifacts. Metadata checks catch malformed fields
and mismatched layout IDs, but do not prove the correctness of an arbitrary
module or the supplied scratch size. Use metadata produced with the model by
the upstream compiler.

## Supported API and limits

The `sample` options are `chains`, `tune`, `draws`, `seed`, `resultFormat`,
`initialPositions`, and `signal`. Other options reject instead of being ignored.
The sampler uses upstream 0.2.0 adaptation defaults, which differ from our Numba
backend. In particular `targetAccept`, `maxDepth`, and jitter controls are not
exposed by this adapter. Do not interpret results as identical sampler settings.

By default each chain starts from `initialPoint`, using seed + chain index.
Supply `initialPositions: [[...], [...]]` for distinct starts, one unconstrained
vector per chain. The upstream sampler may reject stationary/invalid starts;
this adapter does not search or retry them. Starts away from Laplace-prior cusps
also avoid the known ABS derivative-convention difference at zero.

Results explicitly identify `backend: 'tapewasm'` and `space: 'unconstrained'`:

- `samples`: `[chain][draw][parameter]`, or a flat `Float64Array` in binary mode.
- `unconstrained_shape`, `unconstrained_width`, `param_names`, `initial_positions`.
- `sampling_seconds`: sampler construction, warmup, draws, and output copying
  within the worker; excludes worker transport and compatibility conversion.
- `load_seconds`: artifact preparation for source-based fits, zero for reused
  handles. `compile_seconds` is zero because compilation happened beforehand.
- `traces: []`; no `expanded_samples`, `stats`, `idata`, or Arrow results.

There is no expansion, deterministic output, mutable data, streaming/progress
callback, Python execution, or `afterSample`. `capabilities` advertises these
limits. This backend does not promise result parity with the Numba backend.

## Try and test

Serve the repository with `python -m http.server 8000`, then open
`http://localhost:8000/examples/tapewasm.html`. It uses the small checked-in normal
model fixture and the separately installed npm runtime.

`npm test` covers the real published WASM sampler in a worker, Gaussian moments,
repeatability, model rebinding, binary/compatibility output, cancellation,
loading failure/timeout, and unsupported options. Node's worker transport is
shimmed to the browser interface; the sampler itself is not mocked.

An optional external MMM smoke test accepts a directory containing `model.wasm`
and upstream-compatible `meta.json`:

```sh
TAPEWASM_MMM_DIR=/absolute/path/to/artifacts/mmm node --test test_tapewasm.mjs
```

Validated locally with the unchanged 179-observation, 15-parameter MMM compiled
by pymcwasm `edb2dc96623957dcb00532294b63c86603fa994e` and tapewasm-codegen
`35b767bd1852fa71b74ad013d1818279af0e894b`: two chains × 750 warmup + 500 draws
produce 15,000 finite unconstrained values through this public adapter. This is
a functional check, not a posterior-equivalence or browser-performance claim.
