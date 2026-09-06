"""Propagate the requested progressbar setting to deterministic postprocessing."""

import base64
import csv
import hashlib
import io
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path

import requests

ROOT = Path(__file__).parent
BASE_VERSION = "1.1.0"
VERSION = "1.1.0+wasm.1"
metadata = requests.get(
    f"https://pypi.org/pypi/pymc-marketing/{BASE_VERSION}/json", timeout=30
)
metadata.raise_for_status()
file = next(
    x for x in metadata.json()["urls"] if x["filename"].endswith("none-any.whl")
)
response = requests.get(file["url"], timeout=60)
response.raise_for_status()
assert hashlib.sha256(response.content).hexdigest() == file["digests"]["sha256"]
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        archive.extractall(root)
    subprocess.run(
        [
            "patch",
            "-p1",
            "--batch",
            "--input",
            str(ROOT / "patches/marketing-deterministics-progressbar.patch"),
        ],
        cwd=root,
        check=True,
    )
    info = root / f"pymc_marketing-{BASE_VERSION}.dist-info"
    new_info = root / f"pymc_marketing-{VERSION}.dist-info"
    info.rename(new_info)
    path = new_info / "METADATA"
    path.write_text(
        path.read_text().replace(f"Version: {BASE_VERSION}\n", f"Version: {VERSION}\n")
    )
    path = root / "pymc_marketing/version.py"
    path.write_text(
        path.read_text().replace(
            f'__version__ = "{BASE_VERSION}"', f'__version__ = "{VERSION}"'
        )
    )
    (new_info / "RECORD").unlink()
    record = io.StringIO()
    writer = csv.writer(record, lineterminator="\n")
    for path in sorted(root.rglob("*")):
        if path.is_file():
            data = path.read_bytes()
            digest = (
                base64.urlsafe_b64encode(hashlib.sha256(data).digest())
                .rstrip(b"=")
                .decode()
            )
            writer.writerow(
                [path.relative_to(root).as_posix(), "sha256=" + digest, len(data)]
            )
    writer.writerow([f"{new_info.name}/RECORD", "", ""])
    (new_info / "RECORD").write_text(record.getvalue())
    output = ROOT / "wheels" / f"pymc_marketing-{VERSION}-py3-none-any.whl"
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(root))
    manifest = {
        "base_wheel": file["url"],
        "base_sha256": file["digests"]["sha256"],
        "upstream_version": BASE_VERSION,
        "local_patch": "patches/marketing-deterministics-progressbar.patch",
        "version": VERSION,
        "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
    }
    (ROOT / "marketing-backport.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(output)
