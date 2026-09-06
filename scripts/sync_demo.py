"""Copy the package's canonical example into a supplied existing Site checkout."""

import shutil
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
site = Path(sys.argv[1]).resolve()
public = site / "public"
shutil.copytree(root / "examples/mmm", public / "mmm", dirs_exist_ok=True)
shutil.copytree(root / "browser-artifact", public / "nuts", dirs_exist_ok=True)
shutil.copy2(root / "client.mjs", site / "lib/nuts-client.mjs")
for name in ("model.py", "mmm_example.csv"):
    shutil.copy2(root / "examples/mmm" / name, public / name)
(public / "analyze.py").write_text(
    (root / "examples/mmm/diagnostics.py").read_text()
    + "\n"
    + (root / "examples/mmm/predict.py").read_text()
)
shutil.copy2(root / "examples/notebook.html", public / "notebook.html")
shutil.copy2(
    root / "examples/marketing-mix-in-your-browser.ipynb",
    public / "marketing-mix-in-your-browser.ipynb",
)
shutil.copy2(root / "benchmarks/browser.html", public / "benchmark.html")
