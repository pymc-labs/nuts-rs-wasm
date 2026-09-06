"""Package the tested runtime and small adapter separately, with file hashes."""

import hashlib
import json
import shutil
import sys
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
runtime = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
stage = out / "stage"
stage.mkdir(parents=True, exist_ok=True)
shutil.copytree(runtime, stage / "runtime", dirs_exist_ok=True)
shutil.copytree(
    root / "runtime-profile/third-party-licenses",
    stage / "runtime/third-party-licenses",
    dirs_exist_ok=True,
)
shutil.copy2(
    root / "runtime-profile/resolved-environment.json",
    stage / "runtime/resolved-environment.json",
)
shutil.copytree(root / "browser-artifact", stage / "nuts", dirs_exist_ok=True)
shutil.copytree(root / "examples/mmm", stage / "mmm", dirs_exist_ok=True)
shutil.copy2(root / "examples/notebook.html", stage / "notebook.html")
shutil.copy2(root / "benchmarks/browser.html", stage / "benchmark.html")
shutil.copy2(
    root / "examples/marketing-mix-in-your-browser.ipynb",
    stage / "marketing-mix-in-your-browser.ipynb",
)
(stage / "index.html").write_text(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>nuts-rs-wasm</title><style>body{font:18px/1.6 system-ui;max-width:760px;margin:50px auto;padding:20px}a{color:#1257d5}</style><h1>nuts-rs-wasm</h1><p>Run a real PyMC-Marketing model on your device.</p><p><a href="notebook.html">Open the interactive MMM →</a></p><p><a href="marketing-mix-in-your-browser.ipynb" download>Download the notebook</a></p><p><a href="benchmark.html">Repeat the five-fit benchmark</a></p>'
)
(stage / "START-HERE.md").write_text("""# nuts-rs-wasm v0.1.0-alpha.1

Extract both the adapter and runtime archives into the same directory.
Serve this directory with `python -m http.server 8000`, then open
http://localhost:8000/. Do not open the HTML file directly from disk.

The notebook uses the same browser view and WASM sampler. For local use set
its demo_url to http://localhost:8000. All model execution is local.

The adapter is MIT licensed; dependencies retain their own licenses.
Rust notices are in nuts/third-party-licenses; runtime notices are in
runtime/third-party-licenses and inside the original package payloads.
The release runtime is the tested binary environment, with versions and
source/build recipes in the repository's runtime-profile directory.
""")


def manifest(directory):
    files = []
    for p in sorted(directory.rglob("*")):
        if p.is_file() and p.name != "MANIFEST.json":
            files.append(
                {
                    "path": str(p.relative_to(directory)),
                    "bytes": p.stat().st_size,
                    "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
                }
            )
    (directory / "MANIFEST.json").write_text(
        json.dumps({"version": "0.1.0-alpha.1", "files": files}, indent=2) + "\n"
    )


manifest(stage / "runtime")
manifest(stage / "nuts")
archives = [
    ("nuts-rs-wasm-runtime-v0.1.0-alpha.1.tar.gz", ["runtime"]),
    (
        "nuts-rs-wasm-adapter-v0.1.0-alpha.1.tar.gz",
        [
            "nuts",
            "mmm",
            "index.html",
            "notebook.html",
            "benchmark.html",
            "marketing-mix-in-your-browser.ipynb",
            "START-HERE.md",
        ],
    ),
]
for name, paths in archives:
    with tarfile.open(out / name, "w:gz") as tar:
        for path in paths:
            tar.add(stage / path, arcname=path)
    print(name, (out / name).stat().st_size, flush=True)
(out / "SHA256SUMS").write_text(
    "".join(
        hashlib.sha256((out / name).read_bytes()).hexdigest() + "  " + name + "\n"
        for name, _ in archives
    )
)
