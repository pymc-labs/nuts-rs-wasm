"""Compare two native adapters, isolating warmup expansion from model compilation.

Usage: python benchmarks/warmup.py BEFORE_LIBRARY AFTER_LIBRARY OUTPUT_JSON
Build BEFORE_LIBRARY from the parent revision and AFTER_LIBRARY from this revision.
Uses identical compiled callbacks, seeds and sampling options for both libraries.
"""

import ctypes as C
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import numpy as np
import pymc as pm
import pytensor.tensor as pt
from pyarrow import ipc

from benchmarks.native import sample_native  # sets numerical runtime environment
from compile_model import compile_browser_model


def compare(before, after, output):
    namespace = {"DATA_PATH": str(ROOT / "examples/mmm/mmm_example.csv")}
    exec((ROOT / "examples/mmm/model.py").read_text(), namespace)  # noqa: S102 - trusted repository model
    mmm = compile_browser_model(namespace["model"], namespace["var_names"])
    with pm.Model() as expensive_model:
        x = pm.Normal("x", initval=0.1)
        # Large deterministic calculation with tiny stored output, independent
        # of log density: measures expansion rather than Arrow serialization.
        grid = pt.as_tensor_variable(np.linspace(-10, 10, 100_000))
        pm.Deterministic("expensive", pt.sum(pt.sin(grid * x) ** 2))
    expensive = compile_browser_model(expensive_model)
    records = []
    for name, compiled in [("mmm", mmm), ("expensive_deterministic", expensive)]:
        count = 0
        callback_type = C.CFUNCTYPE(
            C.c_int, C.POINTER(C.c_double), C.POINTER(C.c_double)
        )
        original = callback_type(compiled.expand_callback.address)

        @callback_type
        def expand(x, out, original=original):
            nonlocal count
            count += 1
            return original(x, out)

        proxy = SimpleNamespace(**vars(compiled))
        proxy.expand_callback = SimpleNamespace(
            address=C.cast(expand, C.c_void_p).value
        )
        for seed in [42, 142, 242, 342, 442]:
            results = {}
            # Alternate order to reduce systematic timing bias.
            order = [("before", before), ("after", after)]
            if seed in [142, 342]:
                order.reverse()
            for mode, library in order:
                count = 0
                result = sample_native(proxy, Path(library), seed=seed)
                expected = 2500 if mode == "before" else 1000
                assert count == expected, (mode, count, expected)
                records.append(
                    {
                        "model": name,
                        "mode": mode,
                        "seed": seed,
                        "sampling_seconds": result["sampling_seconds"],
                        "expansion_calls": count,
                        "logp_evaluations": result["logp_evaluations"],
                        "leapfrog_steps": result["leapfrog_steps"],
                    }
                )
                results[mode] = result
            a, b = results["before"], results["after"]
            for key in [
                "samples",
                "expanded_samples",
                "stats",
                "divergences",
                "logp_evaluations",
                "leapfrog_steps",
            ]:
                assert a[key] == b[key], key
            for ta, tb in zip(a["traces"], b["traces"]):
                aa = ipc.open_stream(ta["bytes"]).read_all()
                bb = ipc.open_stream(tb["bytes"]).read_all()
                assert aa.schema == bb.schema
                assert aa.num_rows == bb.num_rows == 500
                for col in aa.column_names:
                    if col == "transformation_update_id":
                        # Skipped warmup no longer consumes the event cursor.
                        # The first retained row now identifies its transform.
                        assert aa[col].to_pylist()[1:] == bb[col].to_pylist()[1:]
                        assert bb[col][0].as_py() is not None
                    else:
                        assert aa[col].equals(bb[col]), col
            Path(output).write_text(
                json.dumps(
                    {
                        "platform": "native",
                        "chains": 2,
                        "tune": 750,
                        "draws": 500,
                        "runs": records,
                    },
                    indent=2,
                )
                + "\n"
            )
            print(
                name,
                seed,
                [(r["mode"], round(r["sampling_seconds"], 4)) for r in records[-2:]],
                flush=True,
            )


if __name__ == "__main__":
    compare(*sys.argv[1:])
