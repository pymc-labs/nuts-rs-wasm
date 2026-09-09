"""Pin Notebook.link's solved environment to the audited WASM wheel backports.

Run mambajs 0.22.0 create-lock .nblink/environment.yml .nblink/nblink-lock.json
first. MambaJS accepts PyPI specs but not direct wheel requirements in YAML.
"""

import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

root = Path(__file__).resolve().parents[1]
p = root / ".nblink/nblink-lock.json"
lock = json.loads(p.read_text())
base = "https://raw.githubusercontent.com/pymc-labs/nuts-rs-wasm/c10bf363447adc5f6478b371edf9b1193cbe9771/.nblink/wheels/"
for path in sorted((root / ".nblink/wheels").glob("*.whl")):
    name, version = path.name.split("-")[:2]
    key = next(
        k for k, v in lock["pipPackages"].items() if v["name"].replace("-", "_") == name
    )
    package = lock["pipPackages"].pop(key)
    package.update(
        version=version,
        url=base + path.name,
        size=path.stat().st_size,
        hash={"sha256": hashlib.sha256(path.read_bytes()).hexdigest()},
    )
    lock["pipPackages"][path.name] = package
# Record the complete setuptools wheel for notebook_setup.py. Notebook.link
# filters its code even from pip assets; the helper verifies and restores it.
with urlopen("https://pypi.org/pypi/setuptools/84.0.0/json") as response:
    metadata = json.load(response)
wheel = next(w for w in metadata["urls"] if w["filename"].endswith("none-any.whl"))
lock["pipPackages"][wheel["filename"]] = {
    "name": "setuptools",
    "version": "84.0.0",
    "url": wheel["url"],
    "size": wheel["size"],
    "registry": "PyPi",
    "hash": {"sha256": wheel["digests"]["sha256"]},
}
p.write_text(json.dumps(lock, indent=2) + "\n")
