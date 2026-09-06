"""Regression: native builds must expand constrained parameters and retain Arrow."""

import sys
from pathlib import Path

import numpy as np
import pymc as pm
from pyarrow import ipc

from benchmarks.native import sample_native
from compile_model import compile_browser_model

library = Path(sys.argv[1])
with pm.Model() as model:
    scale = pm.HalfNormal("scale", sigma=1, initval=0.7)
    pm.Deterministic("twice_scale", 2 * scale)
compiled = compile_browser_model(model)
result = sample_native(compiled, library, chains=2, tune=200, draws=200)
assert len(result["traces"]) == 4
starts = np.asarray(result["initial_positions"])
assert np.all(starts >= compiled.initial - 1)
assert np.all(starts < compiled.initial + 1)
assert not np.array_equal(starts[0], starts[1])
assert not np.array_equal(starts[0], compiled.initial)
expanded = np.asarray(result["expanded_samples"])
assert np.all(expanded[:, :, 0] > 0)
np.testing.assert_allclose(expanded[:, :, 1], 2 * expanded[:, :, 0])
assert abs(expanded[:, :, 0].mean() - np.sqrt(2 / np.pi)) < 0.2
for trace in result["traces"]:
    table = ipc.open_stream(trace["bytes"]).read_all()
    assert table.num_rows == 200
    if trace["group"] == "posterior":
        np.testing.assert_allclose(
            np.asarray(table["scale"].to_pylist()).ravel(),
            expanded[trace["chain"], :, 0],
        )
print("Native constrained expansion and Arrow round-trip passed")
