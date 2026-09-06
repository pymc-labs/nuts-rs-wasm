"""Native benchmark of the exact Rust adapter, Numba expansion and Arrow writer."""

import os

os.environ["PYTENSOR_FLAGS"] = "cxx=,blas__ldflags=,numba__cache=False"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
import ctypes as C
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from compile_model import compile_browser_model
from results import to_inference_data


def sample_native(compiled, library, *, chains=2, tune=750, draws=500, seed=42):
    lib = C.CDLL(str(library))
    lib.set_callback.argtypes = [C.c_size_t]
    lib.set_expand_callback.argtypes = [C.c_size_t]
    lib.set_trace_callback.argtypes = [C.c_size_t]
    lib.set_variables.argtypes = [C.c_void_p, C.c_size_t]
    lib.run.argtypes = [
        C.c_size_t,
        C.c_uint32,
        C.c_uint32,
        C.c_uint32,
        C.c_uint32,
        C.POINTER(C.c_double),
        C.c_double,
    ]
    lib.result_ptr.restype = C.c_void_p
    lib.result_len.restype = C.c_size_t
    traces = []

    @C.CFUNCTYPE(None, C.c_uint32, C.c_uint32, C.c_void_p, C.c_size_t)
    def receive(chain, kind, pointer, size):
        traces.append(
            {
                "chain": chain,
                "group": "sample_stats" if kind else "posterior",
                "bytes": C.string_at(pointer, size),
            }
        )

    lib.set_callback(compiled.callback.address)
    lib.set_expand_callback(compiled.expand_callback.address)
    lib.set_trace_callback(C.cast(receive, C.c_void_p).value)
    metadata = json.dumps(compiled.expanded_layout).encode()
    if lib.set_variables(metadata, len(metadata)):
        raise ValueError("Invalid metadata")
    started = time.perf_counter()
    try:
        status = lib.run(
            len(compiled.initial),
            chains,
            tune,
            draws,
            seed,
            compiled.initial.ctypes.data_as(C.POINTER(C.c_double)),
            0.9,
        )
        seconds = time.perf_counter() - started
        result = json.loads(C.string_at(lib.result_ptr(), lib.result_len()))
    finally:
        lib.set_trace_callback(0)
        lib.set_callback(0)
        lib.set_expand_callback(0)
    if status:
        raise RuntimeError(result)
    result.update(
        sampling_seconds=seconds,
        expanded_layout=compiled.expanded_layout,
        layout=compiled.layout,
        coords=compiled.coords,
        traces=traces,
    )
    return result


def main():
    library = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "benchmarks/native.json"
    source = (ROOT / "examples/mmm/model.py").read_text()
    diagnostics = (ROOT / "examples/mmm/diagnostics.py").read_text()
    # Match browser preloading: imports occur before each measured fit.
    exec("import pandas, arviz_stats, pymc_marketing.mmm")  # noqa: S102
    records = []
    for seed in [42, 142, 242, 342, 442]:
        ns = {
            "SEASONALITY": True,
            "DATA_PATH": str(ROOT / "examples/mmm/mmm_example.csv"),
        }
        started = time.perf_counter()
        exec(source, ns)  # noqa: S102 - trusted example source from this repository
        compiled = compile_browser_model(ns["model"], ns["var_names"])
        compile_seconds = time.perf_counter() - started
        result = sample_native(compiled, library, seed=seed)
        ns.update(
            idata=to_inference_data(result),
            _nuts_result=result,
            _nuts_compile_seconds=compile_seconds,
        )
        exec(diagnostics, ns)  # noqa: S102 - trusted example diagnostics
        # Meaningful parity: every Arrow file contains the same constrained values.
        from pyarrow import ipc

        for trace in result["traces"]:
            table = ipc.open_stream(trace["bytes"]).read_all()
            assert table.num_rows == 500
            if trace["group"] == "posterior":
                offset = 0
                for var in compiled.expanded_layout:
                    a = np.asarray(table[var["name"]].to_pylist()).reshape(
                        500, var["size"]
                    )
                    b = np.asarray(result["expanded_samples"][trace["chain"]])[
                        :, offset : offset + var["size"]
                    ]
                    np.testing.assert_allclose(a, b)
                    offset += var["size"]
        records.append(dict(seed=seed, **ns["report"]))
        output.write_text(
            json.dumps({"platform": "native-arm64", "runs": records}, indent=2) + "\n"
        )
    print("Saved", output)


if __name__ == "__main__":
    main()
