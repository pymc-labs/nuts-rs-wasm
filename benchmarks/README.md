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
posterior prediction are excluded. The Rust timer ends after JSON serialization;
JSON decoding and construction of xarray results are outside it. Browser
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
  serve it, open `benchmark.html`, and click **Run five browser fits**. Save the
  displayed JSON as browser.json. Keep the tab running until all five finish.
- Summary and figure: `python benchmarks/summarize.py`.

The native runner additionally checks that each Arrow posterior column agrees
with the corresponding constrained numeric samples. The browser runner requires
all 1,000 streamed retained draws and all four Arrow traces on every fit.
