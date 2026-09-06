# Tested Xeus / emscripten-forge runtime

This profile packages the actual runtime used by the Marketing demo: Python
3.13, Numba 0.66, llvmlite 0.48, PyMC 6.2.0, PyTensor 3.2.4+wasm.3 and
PyMC-Marketing 1.1.0+wasm.1. It is an optional larger distribution of public
upstream packages, separate from the small nuts-rs-wasm adapter.

**Xeus-Python** implements the Python Jupyter kernel. **emscripten-forge** supplies
the WASM Python/scientific packages, including the new Numba compiler stack.

## Prebuilt distribution

Download the runtime archive and adapter archive from the repository's
prereleases, then extract both into your website's static root:

- `runtime/` contains the Xeus worker, Python runtime and packages.
- `nuts/` contains the high-level JS API, Rust WASM, and Python model compiler.

The runtime bootstrap and memory export are already configured. The runtime is
loaded on first use, not copied into each model or compiled again for each fit.
All computation stays in the browser. The initial runtime download is about
120 MB; subsequent fetches may benefit from browser caching depending on the host.

```javascript
import {createSampler} from './nuts/client.mjs';
const sampler = createSampler({
  runtimeUrl: '/runtime/', environment: 'pymc-marketing-wasm',
});
const result = await sampler.sample(pythonModelCode);
```

The binary archive is the same tested runtime as the demo, not a newly rebuilt
untested environment. Its manifest records each file's SHA-256 and size.
The snapshot `resolved-environment.json` records package versions/builds. The
recipe below explains construction; recreating it may produce different archive
bytes as dependency channels and build tooling evolve.

## Build recipe

Run `bash build.sh` with uv, micromamba, Node and patch installed. This creates
local PyTensor and Marketing wheels with the included compatibility patches,
builds a JupyterLite Xeus environment, selects the runtime files and installs
the adapter bootstrap. It does not rebuild LLVM or Numba from source: it uses
the emscripten-forge packages pinned in environment.yml.

The original environment was built with these commands. The extracted build
recipe is provided for inspection and reproduction; the prebuilt release is the
artifact that has undergone the browser sampling test.

PyTensor patches backport target-sized indexing and correct an intp shape cast.
The Marketing patch forwards progressbar=False to deterministic postprocessing.
The loader patch exposes the existing Emscripten memory to the JS bridge. None
of these patches change the model, sampler or target density.

All dependencies retain their own upstream licenses. The release includes original conda license notices under
`runtime/third-party-licenses`, together with notices retained in package payloads.
`licenses.py` retrieves notices from the exact public package builds. Rust and
Comlink notices ship with the separate adapter archive.
