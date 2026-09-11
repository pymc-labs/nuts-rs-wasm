# Reusing Nutpie's model frontend

Status: proposal for discussion. This document changes no runtime behavior and
does not claim that Nutpie's compiler has been validated in Xeus.

The browser adapter currently owns model compilation, mutable-data handling,
initialization and result conversion in addition to its WASM integration. Much
of that overlaps with Nutpie. The proposed direction is to share Nutpie's Python
model frontend while retaining the browser execution adapter until its remaining
responsibilities have an upstream home.

## Evidence and boundary

This review uses Nutpie commit
[`98c0e879`](https://github.com/pymc-devs/nutpie/tree/98c0e879cdd110c14e6bc82a001251b53a990f58)
and the adapter's pinned nuts-rs commit
[`b6f058e9`](https://github.com/twiecki/nuts-rs/tree/b6f058e995c4ce2daa128e4790afab8bd4a71356).

| Responsibility | Current implementation | Proposed ownership |
| --- | --- | --- |
| PyMC graph preparation, gradients, expansion and variable metadata | `compile_model.py` independently assembles these using PyMC/PyTensor | Shared Nutpie Python frontend |
| Numba callbacks and shared-data representation | Local callbacks and a packed float64 buffer | Prefer Nutpie's callback/data contract, subject to Xeus validation |
| Initial-point generation | PyMC base point plus Rust coordinate jitter | PyMC initial-point function, as used by Nutpie; preserve explicit browser option semantics during migration |
| Sequential sampling, initialization retries, storage and progress | Rust adapter calls existing nuts-rs chain/storage APIs | Keep initially; consider an upstream synchronous runner separately |
| Arrow-to-labeled-results conversion | Local numeric-buffer conversion with three statistics | Shared conversion if browser dependencies and trace schema permit |
| Cross-memory calls, worker lifetime, cancellation and JS delivery | Browser bridge and client | Browser adapter |

The actual NUTS algorithm, adaptation and Arrow trace storage already come from
nuts-rs. PyMC provides transformations and deterministic expressions. The main
duplication is the integration around those implementations.

## Why a direct import does not work today

Nutpie's [package initialization](https://github.com/pymc-devs/nutpie/blob/98c0e879cdd110c14e6bc82a001251b53a990f58/python/nutpie/__init__.py)
imports the native `_lib` extension. Its
[model compiler](https://github.com/pymc-devs/nutpie/blob/98c0e879cdd110c14e6bc82a001251b53a990f58/python/nutpie/compile_pymc.py)
also imports `_lib`, `CompiledModel` and `compiled_pyfunc`; those modules bring
additional native-extension dependencies into the import path.

Graph preparation in `_make_functions` is Python/PyMC/PyTensor code. The Numba
callback builders likewise do not inherently require constructing a native
Nutpie sampler. This suggests a separable frontend, rather than requiring a
second implementation of the same model semantics.

The proposed upstream change is an independently importable frontend returning
compiled density/expansion callbacks, metadata, initial-point generation and
owned data buffers. Native model construction and sampling would consume that
result through a separate layer. Merely moving one `_lib` import is insufficient:
package initialization, base types and transitive imports must also be separated.
Installation must support this frontend without requiring a native extension
build. The exact public API and packaging should be agreed with Nutpie maintainers.

## Compatibility work remains

Nutpie's callbacks use status returns, separate log-density output storage,
64-bit dimension arguments and a user-data pointer. Our bridge currently calls
different signatures. It must adapt the contract, including WASM i64 argument
handling, error propagation and callback/buffer lifetime.

Nutpie retains shared arrays with their original dtypes and pointer/shape
metadata. Separate Rust and Python memories do not by themselves require our
float64 packing: these arrays can stay in the Python runtime where Numba accesses
them. Its pointer extraction and Numba internals still need testing in the exact
Xeus build. Our same-shape update policy, frozen-data default and handle isolation
must remain explicit compatibility decisions.

Expansion selection and ordering also differ: Nutpie includes joined value
variables in its expanded representation. Reusing it requires mapping its output
metadata to our selected variables rather than assuming identical flat arrays.

For initialization, Nutpie delegates to PyMC's `make_initial_point_fn`. Our
coordinate jitter has a different RNG sequence and does not implement that full
initialization contract. Migrating must specify how `jitter`, retries and seeded
reproducibility behave; do not silently promise identical historical draws.

## Why the Rust and worker adapter remains

The pinned [nuts-rs sampler](https://github.com/twiecki/nuts-rs/blob/b6f058e995c4ce2daa128e4790afab8bd4a71356/src/sampler.rs)
uses a controller thread and a Rayon pool for its high-level runner.
`sample_sequentially` provides an iterator over `draw()` and progress, but does
not provide the complete expansion, trace-storage and live-batch loop used here.
Our loop therefore fills an execution gap for the current single-worker setup.
A synchronous upstream runner could reduce this code later.

The present Rust and Xeus modules have independent memories. The bridge handles
copies, function-table access and buffer lifetimes; the client handles worker
startup, cancellation and result delivery. Reusing the model compiler does not
remove these responsibilities. A shared-memory Emscripten backend is a separate,
unvalidated integration project; see [the direct-call investigation](direct-wasm-calls.md).

## Result conversion

Nutpie's [result conversion](https://github.com/pymc-devs/nutpie/blob/98c0e879cdd110c14e6bc82a001251b53a990f58/python/nutpie/sample.py)
already handles Arrow batches, dimensions, warmup and sampler statistics. Our
`results.py` instead constructs labeled results from parallel numeric buffers
and exposes only `diverging`, `n_steps` and `step_size`; the Arrow traces retain
the full upstream statistics.

A reusable conversion module could consolidate this path. First verify Arrow
availability in the shipped browser runtime and compatibility with the pinned
trace schema, coordinates and ArviZ/xarray versions. Live numeric batches remain
useful to JavaScript consumers, and stream-only mode must remain independent of
full-trace conversion. Do not add a second permanent conversion implementation
just to imitate Nutpie's output.

## Proposed sequence and acceptance checks

1. Agree on the extension-independent frontend boundary in Nutpie. Extract the
   existing implementation there, with a check that it imports and compiles a
   simple PyMC model when `_lib` is unavailable. Preserve native behavior.
2. Run a bounded Xeus integration probe using those upstream callbacks. Compare
   log density, gradients and expansion against PyMC for Gaussian, transformed,
   simplex and deterministic models, plus the MMM example. Exercise original
   data dtypes, updates, pointer widths, status errors and memory growth.
3. Replace the local compiler after that probe passes. Verify variable selection,
   coordinates, frozen/mutable data, independent handles, release and cancellation.
   Specify and test the initialization migration rather than matching RNG streams
   between different implementations.
4. Consolidate result conversion after checking runtime dependencies and Arrow
   read-back. Verify complete statistics, dimensions and unchanged stream mode.
5. Consider moving the synchronous chain loop into nuts-rs separately, with
   expansion, storage and progress hooks that serve native callers too.

The first implementation PR should address the Nutpie frontend boundary. This
proposal deliberately makes no estimate of removable lines or browser speedup:
neither follows from source inspection alone.
