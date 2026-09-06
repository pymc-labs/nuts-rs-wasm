"""Select Xeus runtime assets; do not distribute the generated notebook UI."""

import shutil
from pathlib import Path

root = Path(__file__).resolve().parent
output = root / "_output"
target = root / "runtime"
target.mkdir(exist_ok=True)
shutil.copytree(output / "xeus", target / "xeus", dirs_exist_ok=True)
workers = list(output.rglob("comlink.worker.js"))
if len(workers) != 1:
    raise RuntimeError(f"Expected one Xeus worker, found {workers}")
shutil.copy2(workers[0], target / "comlink.worker.js")
for unpack in output.rglob("unpack-*.wasm"):
    shutil.copy2(unpack, target / unpack.name)
