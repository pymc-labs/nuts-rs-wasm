import unittest
from pathlib import Path

import numpy as np
from pyarrow import ipc

from results import to_inference_data


class ResultsTests(unittest.TestCase):
    def test_arrow_from_real_wasm(self):
        paths = list(Path("/tmp/arrow-test").glob("*.arrow"))
        self.assertEqual(len(paths), 4)
        for path in paths:
            table = ipc.open_stream(path).read_all()
            self.assertEqual(table.num_rows, 500)
            if "sample_stats" in path.name:
                self.assertIn("depth", table.column_names)
            else:
                array = np.array(table["unconstrained"].to_pylist())
                self.assertEqual(array.shape, (500, 2))
                self.assertLess(abs(array.mean()), 0.2)

    def test_xarray_named_dimensions(self):
        result = {
            "expanded_samples": [[[1.0, 2.0], [3.0, 4.0]]],
            "expanded_layout": [
                {"name": "x", "size": 2, "shape": [2], "dims": ["group"]}
            ],
            "coords": {"group": ["a", "b"]},
            "stats": [[{"diverging": False, "n_steps": 3, "step_size": 0.1}] * 2],
        }
        idata = to_inference_data(result)
        self.assertEqual(idata.posterior.x.dims, ("chain", "draw", "group"))
        self.assertEqual(idata.posterior.x.sel(group="b").values.tolist(), [[2.0, 4.0]])


if __name__ == "__main__":
    unittest.main()
