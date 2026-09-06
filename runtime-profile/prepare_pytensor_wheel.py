"""Backport upstream f079760a2 to the release supported by PyMC-Marketing."""

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
BASE_VERSION = "3.2.4"
VERSION = "3.2.4+wasm.3"
metadata = requests.get(
    f"https://pypi.org/pypi/pytensor/{BASE_VERSION}/json", timeout=30
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
            str(ROOT / "patches/pytensor-target-sized-indices.patch"),
        ],
        cwd=root,
        check=True,
    )
    subprocess.run(
        [
            "patch",
            "-p1",
            "--batch",
            "--input",
            str(ROOT / "patches/pytensor-core-shape-intp.patch"),
        ],
        cwd=root,
        check=True,
    )
    info = root / f"pytensor-{BASE_VERSION}.dist-info"
    new_info = root / f"pytensor-{VERSION}.dist-info"
    info.rename(new_info)
    path = new_info / "METADATA"
    path.write_text(
        path.read_text().replace(f"Version: {BASE_VERSION}\n", f"Version: {VERSION}\n")
    )
    path = root / "pytensor/_version.py"
    path.write_text(
        path.read_text().replace(
            f'"version": "{BASE_VERSION}"', f'"version": "{VERSION}"'
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
    output = ROOT / "wheels" / f"pytensor-{VERSION}-py2.py3-none-any.whl"
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(root))
    manifest = {
        "base_wheel": file["url"],
        "base_sha256": file["digests"]["sha256"],
        "upstream_commit": "f079760a2cbbb78436d91aaf79bf7ec605b5f243",
        "local_patch": "patches/pytensor-core-shape-intp.patch",
        "version": VERSION,
        "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
    }
    (ROOT / "pytensor-backport.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(output)
