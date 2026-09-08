# MMM rerun — 8 September 2026

Current nuts-rs-wasm 0.1.0, built from release commit 0be81f7 (merged unchanged as 5baf1de). Apple M3, same machine for native and browser. Ten native fits completed before the ten browser fits; no benchmark compilation/build ran concurrently. Ordinary desktop activity was not controlled. Exact source/binary hashes and settings are in provenance.json; native versions are in versions.json. The browser uses the same previously bundled Xeus runtime and patched PyTensor/PyMC-Marketing versions.

Two sequential chains, 750 warmup + 500 retained draws per chain, five seeds (42, 142, 242, 342, 442), 179 weeks, 15 parameters, seasonality enabled. targetAccept 0.9, initial jitter 1, maxDepth 10, initRetries 10. Both platforms retain unconstrained and expanded values and Arrow; both use binary numeric output. Browser callback caching is the default callbacks mode, with live batches enabled.

| Median of five fits | Native | Browser |
|---|---:|---:|
| Fresh model: warmup + sampling + expansion + Arrow | 0.754 s | 7.835 s |
| Fresh model: preparation + compilation + above | 13.577 s | 21.749 s |
| Reused model: warmup + sampling + expansion + Arrow | 0.733 s | 7.957 s |
| Reused model: whole call including results and diagnostics | 0.778 s | 8.085 s |

One-time reused preparation: 11.989 s native / 15.621 s browser. Imports and runtime loading are excluded. The fresh first fit can still include lazy initialization. Sampling includes the Rust run, warmup, expansion, Arrow recording/serialization and native Arrow callback copying; browser additionally includes JavaScript bridging and live delivery. Numeric array construction, worker transfer, xarray and diagnostics are outside the sampling timer but inside wall_seconds. Posterior prediction is excluded from all timers. Native uses C callbacks; browser uses WASM callbacks via JavaScript. The Python sampling baseline was not rerun.

Sampling ratio (fresh medians): 10.39×. Compile-inclusive ratio: 1.60×. Reused compilation is zero on every fit. Per-seed diagnostics and evaluation counts agree exactly between fresh and reused fits within each platform. All twenty fits had zero divergences. Raw ESS and R-hat are retained in the JSON; timings do not establish a platform effect on convergence. New initialization changes seeded trajectories relative to the September 6 benchmark, so changes in elapsed time cannot be attributed solely to implementation optimizations.

Validation: native checks all four Arrow traces and equality of every constrained posterior column with numeric results; browser requires 1,000 streamed draws, four traces and diagnostics per fit. Both native and browser use the repository's shared MMM and diagnostics sources.

## Reproduce

Build the pinned native and WASM adapters using Rust 1.94.0, as described in the repository README. Use the package-compatible Python environment from versions.json.

Run `python benchmarks/2026-09-08/native-rerun.py` first. It writes native.json beside itself. Then run `python benchmarks/2026-09-08/serve.py /path/to/compatible/runtime 8769`, open http://localhost:8769/benchmark.html and click **Run browser benchmark**. Keep the tab active until it reports ten completed fits. The server saves browser.json. The server stages the current worker bootstrap alongside the supplied compatible runtime without modifying that runtime. Run `python benchmarks/2026-09-08/summarize.py` to regenerate the summary and figure.

Historical September 6 records remain unchanged in the parent directory. The native helper adds optional binary extraction so native and browser use comparable result storage; it leaves the default JSON interface unchanged.
