# Same adapter, five fits per platform

Measured 6 September 2026 on one MacBook Air M3. Two sequential chains,
750 warmup + 500 retained draws per chain, target acceptance 0.9, seeds
42, 142, 242, 342, 442 (each chain adds its index). Yearly seasonality enabled.

| Median of five fits | Native | Browser |
|---|---:|---:|
| Warmup + sampling + expansion + Arrow recording/serialization | 0.807 s | 7.999 s |
| Model preparation + compilation + sampling | 9.804 s | 19.357 s |
| Minimum bulk ESS per sampling second | 194.5 | 21.9 |

Imports are preloaded. Each fit constructs a new model and compiles new density
and expansion callbacks with Numba caching disabled. The initial fit can still
pay lazy-initialization costs. Imports, runtime download, diagnostics and
posterior prediction are excluded. These historical records used numeric JSON serialization inside the Rust timer;
JSON decoding and construction of xarray results were outside it. Browser
sampling includes JS bridge copies and live sample delivery; native sampling
includes Arrow byte delivery to Python. Native C callbacks and browser WASM
callbacks call the same compiled model/expansion graphs.

The Python environment on both targets uses PyMC 6.2.0, PyTensor 3.2.4+wasm.3,
PyMC-Marketing 1.1.0+wasm.1, Numba 0.66 and llvmlite 0.48. The browser is recorded
in browser.json; runtime builds are in ../runtime-profile/resolved-environment.json.

Raw fits are in native.json and browser.json. All had zero divergences, but
max R-hat reached 1.025 and minimum bulk ESS ranged from 110 to 186. Seeds do
not make native and WASM trajectories identical; floating-point differences
change adaptation and paths. This is not a comparison at matched posterior
precision. These are repeated observations on one workstation, not a controlled
cross-device benchmark; routine desktop activity may affect timings.

## Reproduce

Build the adapter with `npm ci --ignore-scripts && npm run build` and a native
library with `cargo +1.94.0 build --locked --release --manifest-path adapter/Cargo.toml`.
Use the compatible pinned Python environment above, plus PyArrow and Matplotlib.

- Native: `python benchmarks/native.py adapter/target/release/libnuts_browser_adapter.dylib`
  (use `.so` on Linux).
- Browser: extract the adapter and runtime release archives into one directory,
  serve it, open `benchmark.html`, and choose **Cold compilation** and click **Run browser benchmark**. Save the
  displayed JSON as browser.json. Keep the tab running until all five finish.
- Summary and figure: `python benchmarks/summarize.py`.

The native runner additionally checks that each Arrow posterior column agrees
with the corresponding constrained numeric samples. The browser runner requires
all 1,000 streamed retained draws and all four Arrow traces on every fit.


## Issue implementation measurements

`warmup.json` contains five paired native runs of the original adapter and an
adapter with only the warmup optimization. Both use the same compiled callbacks
and seeds; order alternates by seed. Expansion calls fall from 2,500 to 1,000.
MMM median sampling time is effectively unchanged (0.884821 vs 0.884786 seconds).
A scalar Gaussian with a 100,000-point sine deterministic falls from 0.710058 to
0.284988 seconds. Expansion savings depend on the cost of deterministics; the
60% callback reduction is not a general 60% sampling speedup.

`warmup.py BEFORE_LIBRARY AFTER_LIBRARY OUTPUT_JSON` reproduces this comparison
using the compatible Python environment. Build the original library from commit
`1124d88fb246411572fb5d5a256ac42b9dc2d2f6` and the second with only the warmup
loop change to isolate that change from result transport. The runner checks
identical seeded samples, counters and every Arrow column. The first retained
`transformation_update_id` is intentionally populated after the change; the
remaining rows agree.

The browser MMM page now offers cold, reused and combined modes. Reused mode
prepares one handle before its five fits. `compile_seconds` is zero on those
fits and `model_compile_seconds` records the one-time preparation. `wall_seconds`
includes worker communication, Python result construction and diagnostics;
`sampling_seconds` covers the Rust call. `preparation_wall_seconds` is reported
separately. Runtime loading and preloaded imports are outside those timers.

Run `PYTHON=/path/to/python node benchmarks/result-postprocessing.mjs` for small
and large synthetic result comparisons. It measures numeric conversion,
actual Node worker transfer, Python ingestion and xarray construction in
separate fresh processes. Node and Python peak resident memory include their
runtimes and are reported separately; they are not a combined process-tree peak
or browser-memory measurement. The compatibility branch models the former
JSON path, while binary uses local files. Neither branch measures sampling.

For actual browser transfer and local xarray construction, serve `results.html`
next to the same `nuts/` and `runtime/` directories as `benchmark.html`. The
page tests small and large traces in both public output formats, with and
without unconstrained retention, and checks coordinates, statistics, streamed
draw counts and Arrow files. Its wall time includes all postprocessing;
Python preparation is also reported separately. Browsers do not expose a
portable total worker peak-memory measurement: main-page heap snapshots are
explicitly labeled as partial, nonpeak observations.


`browser-reuse.json` records the selected timing/count fields from ten real MMM
fits: all reused fits have zero compilation time, and per-seed evaluation counts
and diagnostics agreed. The one-time reused preparation took 25.22 seconds.
Native compilation and other desktop activity overlapped this exploratory run,
so its cold/reused wall-time ratio is not a controlled speedup estimate.

`browser-results.json` records eight real browser configurations. For the large
trace with unconstrained retention, compatibility and binary wall times were
170.7 and 92.5 milliseconds, respectively; these are single observations in
fixed order. Both paths already use worker-local binary Python ingestion, so
this compares public output formats, not the old numeric JSON implementation.
The first small fit includes lazy initialization. Heap snapshots are not peaks
and accumulate objects awaiting garbage collection.

`result-postprocessing.jsonl` records the independent synthetic Node/Python run.
For its large trace, Node peak RSS was about 270 MB with compatibility conversion
and 75 MB with binary transfer; separate Python peak RSS was 241 vs 139 MB.
These process peaks include their runtimes and must not be added as a concurrent
combined peak. Timings are sensitive to machine activity; rerun the harness.

## Callback and view caching

The normal bridge caches native callbacks once per fit (`bridgeCache: 'callbacks'`).
The experimental `views` option also keeps eight typed array view slots, keyed
by the current buffer, pointer and length; `none` disables both caches.
View caching is opt-in because the available MMM measurements do not establish
an end-to-end benefit. These options change bridge bookkeeping only; memories
and copies remain separate. The measurements below retain their explicit modes
and remain valid after changing the default.

`node benchmarks/build-bridge-callback.mjs` rebuilds the tiny actual WASM
callback fixture from `bridge-callback.rs`. Run
`node benchmarks/bridge-cache.mjs` for seven repetitions after warmup at widths
2 and 1,024, or serve the repository and open
`benchmarks/bridge-cache.html`. These timers exclude model compilation, Arrow
and final result serialization. The Node records include engine and platform
versions. Small-vector median logp calls were 153, 132 and 99 ns for uncached,
callback-only and full caching; at width 1,024 they were 1,138, 1,135 and 1,132 ns.
Fewer allocations do not establish a whole-fit speedup.

To compare actual MMM end-to-end behavior, select **Reused model** and
**Compare all three bridges** in the MMM page. One compiled handle serves all
15 measured fits. A short untimed fit warms each bridge; mode order reverses
on alternating seeds. Compilation and Python postprocessing remain separately
reported.


`bridge-cache-browser-summary.json` records seven browser repetitions. Width-2
logp medians were 125.5, 107.5 and 77.5 ns for uncached, callback-only and full
caching; at width 1,024 they were 1,105, 1,065 and 1,070 ns. Copying/model work
dominates the larger vector.

`browser-bridge-cache.json` records the real 15-fit MMM comparison. All cache
variants reproduced per-seed evaluation counts and diagnostics, with no
divergences. Sampling medians were 9.715, 10.270 and 9.931 seconds, respectively.
Several consecutive fits took about 40 seconds amid otherwise 8–14-second runs;
these unstable conditions do not establish an end-to-end caching speedup.
