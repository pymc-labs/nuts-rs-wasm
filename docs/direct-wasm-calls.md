# Direct WASM calls: feasibility investigation

Status: direct cross-module Numba density/gradient and expansion callbacks are
demonstrated for both a transformed Gaussian model and the real MMM; a jointly linked
Rust NUTS + Numba runtime has **not** been built or validated. The existing
independent-memory JavaScript bridge remains the supported sampling path. This
report addresses issue #6 as an architectural investigation, not a production
backend or a claimed MMM speedup.

## What the current binaries establish

The inspected runtime is the repository's published Xeus profile, containing
`emscripten-abi-4.0.9-h267e887_9`, Numba 0.66 and llvmlite 0.48. These observations
come from the actual `xpython.js`, `xpython.wasm`, package payloads and current
adapter binary, rather than assumptions about a generic Emscripten runtime:

| Component | Observed layout/loading |
| --- | --- |
| Rust `wasm32-unknown-unknown` adapter | Own exported memory, initial 1,179,648 bytes, `__heap_base=1,139,120`; no imported memory/table and no `dylink.0` section. Inspected binary: 1,310,229 bytes. |
| `xpython.wasm` | 15,727,483 bytes; `dylink.0`; imports runtime memory, indirect function table, mutable stack pointer, memory/table relocation bases and exception tags. Exports malloc/free/calloc/realloc/aligned_alloc. |
| Xeus loader | Initial memory 67,108,864 bytes, maximum 2 GiB; initially 13,553 growable function-table slots. Stack spans 4,483,680–38,038,112, with heap beginning at 38,038,112. Side-module data is reserved through the main runtime allocator after initialization, then exports are relocated. |
| Numba/llvmlite | Numba targets `wasm32-unknown-emscripten` with SIMD enabled. llvmlite builds position-independent code, links with `wasm-ld -shared --import-memory --stack-first --allow-undefined`, loads via `ctypes.CDLL(..., RTLD_GLOBAL)`, and obtains function-table indices through ctypes function pointers. |

Package source locations are `numba/core/codegen.py` around lines 1338–1351 and
`llvmlite/binding/wasmengine.py` around lines 316–325, 367–376 and 647 in the pinned
runtime archives. Line numbers refer to those payloads, not upstream HEAD.
`configure-runtime.mjs` already exposes the main runtime's memory for the bridge.
`getWasmTableEntry` in the inspected loader returns native `wasmTable.get(index)`
functions through a cache.

Importing that memory into the **existing** Rust binary is not a valid conversion:
its fixed data, stack and allocator addresses were linked independently. Changing
only a memory import would not relocate them or establish allocation ownership.
Likewise, importing a native Numba function directly into the existing Rust
instance removes a language boundary but does not make Rust pointers designate
Numba's memory.

## Plausible complete build paths and remaining blockers

Emscripten's supported dynamic-linking model has one main runtime with system
libraries and separately linked side modules. The current Xeus loader already
uses this model for Python extensions. A new sampler side module is the strongest
candidate: compile the adapter for `wasm32-unknown-emscripten` with position
independence and `SIDE_MODULE`, then load it through the existing dynamic loader.
The loader must reserve its data/table ranges and resolve shared runtime symbols;
plain `WebAssembly.instantiate` with a shared memory is insufficient. A static
alternative is an Emscripten-compatible Rust archive linked while rebuilding the
Xeus main runtime; this couples every sampler update to that runtime's release.
See [Emscripten dynamic linking](https://emscripten.org/docs/compiling/Dynamic-Linking.html).

The runtime package pins ABI 4.0.9. SDK version alone does not establish ABI
compatibility: exception, SIMD and other compilation settings must match. Rust's
Emscripten target documentation recommends rebuilding Rust `std` against the
chosen Emscripten configuration using nightly `-Zbuild-std`, because prebuilt
`std` and other Emscripten builds can disagree. `panic=abort` in this adapter is
not proof that all runtime ABI requirements match. See
[Rust Emscripten ABI compatibility](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-emscripten.html#emscripten-abi-compatibility).

A complete implementation must additionally:

1. Split the adapter's broad `target_arch="wasm32"` bridge imports from an
   Emscripten-specific path. That path should invoke C function pointers for
   density (`f64(i32,i32)`) and expansion (`i32(i32,i32)`) using runtime table
   indices. Its initial, gradient, expansion, Arrow and sampler allocations must
   all use the coordinated runtime address space.
2. Link Rust allocation/deallocation through a compatible runtime allocator,
   resolve the shared stack and relocation bases, and verify imported symbols
   against this exact Xeus build. Do not introduce a second heap with an
   independent high-water mark. Cargo's dependency graph for the Emscripten target
   does not include the `wasm-bindgen` branch used by this adapter's current
   unknown-unknown target, which removes one present import-namespace obstacle.
3. Add an optional worker loader entry that loads the side module only after
   Xeus initialization, installs callbacks for the selected compiled handle, and
   exports sampling/result functions without disturbing the current fallback.
4. Validate every native callback/expansion status and preserve progress, Arrow
   serialization and transfer semantics. Streaming and final output still cross
   JavaScript boundaries; removing density crossings does not remove all JS work.

No matching Rust/Emscripten sampler build was completed in this investigation.
The ABI/link configuration, full crate build, runtime symbol resolution and
loader integration remain unvalidated engineering work. These are precise
blockers to claiming a complete direct sampler, rather than evidence that the
architecture is impossible.

Distribution consequences differ substantially: a side module needs a separate
ABI-tagged artifact and explicit runtime compatibility checks; a static build
needs a new Xeus binary and runtime archive. Neither replaces the portable
independent-memory adapter artifact. Full side-module size, startup changes,
peak runtime memory and end-to-end MMM performance are **not measured** here.

## Reproducible, deliberately bounded prototype

`prototypes/direct-wasm-calls/direct.wat` imports a runtime memory and two native
WASM functions. Its loop invokes density directly inside WASM; it also invokes
expansion. It contains no data segments, linear-memory stack, allocator, table
reservations or `memory.grow`. Therefore it cannot collide with runtime-owned
allocations. This is a 190-byte stateless WASM caller, **not Rust NUTS**, and
`cheap-callback.wat` is an actual 171-byte WASM fixture, **not Numba**.

Run the checked-in binaries and assertions with:

```sh
node prototypes/direct-wasm-calls/check-and-benchmark.mjs
```

To rebuild from readable source with WABT:

```sh
npx --yes --package=wabt -- wat2wasm prototypes/direct-wasm-calls/direct.wat -o prototypes/direct-wasm-calls/direct.wasm
npx --yes --package=wabt -- wat2wasm prototypes/direct-wasm-calls/cheap-callback.wat -o prototypes/direct-wasm-calls/cheap-callback.wasm
```

`direct.mjs` can instantiate this caller using the runtime's native table entries
and a compiled model configuration. The embedding worker must retain the Python
compiled model and call `close()` before releasing its handle. The prototype is
not wired into `BrowserSampler`, and it cannot enforce that worker's lifecycle
by itself. A JavaScript wrapper substituted for a native WASM callback would
reintroduce the boundary under investigation.

The runtime owns all input/output buffers. The fixture reserves its own explicit
small buffers; those fixed fixture offsets must never be used inside Xeus. Real
use supplies `BrowserModel` pointers. JS callers initialize input and read output,
but the repeated direct-call loop performs neither copies nor JS calls. The
Node prototype checks log density, gradient, deterministic expansion, growth of
both fixture memories, repeated invocations and explicit caller invalidation.
The separate browser probe below covers actual Numba callbacks and verifies
that ordinary bridge sampling remains correct afterward. Neither demonstrates
a Rust allocator sharing Xeus memory or a complete direct sampler.

The current compiled-model registry keeps callbacks alive until explicit release
or worker teardown. llvmlite also retains dynamic-library handles and temporary
library directories internally: releasing a model must not be advertised as
unloading all JIT code or reclaiming its table slots. Terminating the worker is
the reliable whole-runtime reclamation boundary. A direct backend must apply the
same generation checks and invalidate all pointers on replacement.

## Actual Numba browser probe

The optional `browser.html` and `worker-probe.js` extend a **test-only** worker
bootstrap; production sampling files are unchanged. Given an existing static
root serving `runtime/` and `nuts/`, set up the isolated route with:

```sh
node prototypes/direct-wasm-calls/setup-browser-probe.mjs /path/to/static-root
```

Open `/direct-prototype/browser.html` on that server and run the checks. The page
compiles a Gaussian plus HalfNormal and a deterministic, then compares direct
native Numba density/gradient/expansion callbacks with both bridge variants and
analytic values at three positions. It also measures the same four call paths
with the real callbacks. Afterward it runs ordinary bridge sampling to check
transforms, deterministic values, Arrow groups, streaming and same-seed reuse.
The page then prepares the real MMM and compares density, gradients and
expansion at three positions, with 1,000 density calls per timing run in each
mode. It does not run a new direct MMM sampler. The final Gaussian and MMM
results are available as `window.directProbeResults` for recording. The setup
script also routes `/mmm/` to the committed example if no such route exists.
These sampling checks exercise the fallback after the experiment; they are not
end-to-end tests of a new Rust backend. The probe **passed in Chrome 152 on macOS**
on 2026-09-06. Density, gradient and expansion matched both bridge variants at
all three positions for both models; Gaussian analytic checks also passed. All
fallback sampling, transform, deterministic, Arrow, streaming, reuse and
release/teardown checks passed. Selected raw timing measurements and check
results are recorded in `prototypes/direct-wasm-calls/browser-results.json`.

## Measurements and what they isolate

The committed `cheap-results.json` records seven runs of one million calls after
a warm-up, on Node v25.8.1 / macOS ARM64. The caller loop is WASM in every case.
Each callback computes a two-dimensional Gaussian density and writes a gradient.
The two copy modes reproduce the existing bridge algorithms; this standalone
fixture does not benchmark the production worker or browser runtime.

| Fixture path | Median milliseconds / million calls |
| --- | ---: |
| JS, fresh views and buffer copies | 187.219 |
| JS, cached callback/views and buffer copies | 67.911 |
| JS forwarding with already shared buffers | 13.843 |
| Native WASM import with already shared buffers | 4.657 |

The last two rows isolate the language boundary with identical shared-buffer
ownership; they do not confound boundary removal with copy removal. Comparing
copying against shared-buffer rows also changes memory layout and view work.
Measurements run in fixed order and are a microbenchmark, not a browser speedup
estimate. The fixture allocates two 128-KiB memories after growth (262,144 bytes
combined); this is explicit linear-memory capacity, not a process RSS or real
MMM memory measurement. No runtime archive changes are required for this
standalone fixture; that says nothing about a complete linked sampler's startup.

The actual browser Numba callback measurements are substantially less dramatic:

| Callback path | Gaussian median ms / 20,000 calls | MMM median ms / 1,000 calls |
| --- | ---: | ---: |
| JS, fresh views and copies | 18.100 | 111.500 |
| JS, cached callback/views and copies | 16.200 | 110.000 |
| JS, already shared buffers | 15.400 | 108.800 |
| Native WASM import, already shared buffers | 14.300 | 107.100 |

These are five fixed-order timing runs per mode after warm-up. MMM timings
strongly overlap across modes, and these few runs do not establish a reliable
end-to-end benefit. The near-empty WASM fixture's results cannot be projected
onto this actual model. The observed runtime memory capacities were 291,110,912
bytes after the Gaussian probe and 503,185,408 after MMM; they include imported
runtime and prior retained state. They are not peak live allocations or
per-backend memory costs.

Full direct-Rust MMM end-to-end, peak-memory and runtime-size comparisons remain
unavailable because that backend has not been built. Existing bridge/cached-
bridge MMM sampling measurements must remain labeled by their actual path;
they cannot fill the missing direct-Rust sampler column. The native/WASM
performance gap is not attributed to JavaScript by these measurements.

The next decisive experiment is an ABI-matched Rust side module invoking the
actual Numba callbacks demonstrated here, followed by the same-seed transformed model, Arrow,
streaming, repeated-fit, growth and teardown tests and cold/reused MMM benchmarks
against both bridge variants. Until then, issue #6 remains a documented
feasibility investigation with a bounded proof of direct scalar calls.
