import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from pyarrow import ipc

from results import load_worker_result, to_inference_data


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

    def test_local_binary_loader_owns_data_and_cleans_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result"
            path.mkdir()
            values = np.array([1.0, 2.0, 3.0, 4.0], dtype="<f8")
            values.tofile(path / "expanded_samples.bin")
            np.array([0, 3, 0.1, 1, 7, 0.2], dtype="<f8").tofile(path / "stats.bin")
            metadata = {
                "shape": [1, 2, 2],
                "unconstrained_width": 1,
                "expanded_samples_file": str(path / "expanded_samples.bin"),
                "stats_file": str(path / "stats.bin"),
                "expanded_layout": [
                    {"name": "x", "size": 2, "shape": [2], "dims": ["group"]}
                ],
                "coords": {"group": ["a", "b"]},
            }
            manifest = path / "metadata.json"
            manifest.write_text(json.dumps(metadata))
            result = load_worker_result(manifest)
            self.assertFalse(path.exists())
            idata = to_inference_data(result)
            self.assertEqual(
                idata.posterior.x.sel(group="b").values.tolist(), [[2.0, 4.0]]
            )
            self.assertEqual(idata.sample_stats.diverging.dtype, np.dtype(bool))
            self.assertEqual(idata.sample_stats.n_steps.values.tolist(), [[3, 7]])

    def test_invalid_manifest_cleans_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result"
            path.mkdir()
            (path / "expanded_samples.bin").write_bytes(b"partial")
            manifest = path / "metadata.json"
            manifest.write_text("{broken")
            with self.assertRaises(json.JSONDecodeError):
                load_worker_result(manifest)
            self.assertFalse(path.exists())

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
