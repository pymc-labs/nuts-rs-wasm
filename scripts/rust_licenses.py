"""Retain upstream notices alongside the distributed Rust binary."""

import json
import os
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
metadata = json.loads(
    subprocess.check_output(
        [
            "cargo",
            "metadata",
            "--locked",
            "--format-version",
            "1",
            "--manifest-path",
            str(root / "adapter/Cargo.toml"),
        ],
        env={**os.environ, "RUSTUP_TOOLCHAIN": "1.94.0"},
    )
)
target = root / "browser-artifact/third-party-licenses"
target.mkdir(exist_ok=True)
records = []
for p in metadata["packages"]:
    crate = Path(p["manifest_path"]).parent
    dest = target / (p["name"] + "-" + p["version"])
    files = []
    for pattern in ["LICENSE*", "LICENCE*", "COPYING*", "NOTICE*", "COPYRIGHT*"]:
        for f in crate.glob(pattern):
            if f.is_file():
                dest.mkdir(exist_ok=True)
                shutil.copy2(f, dest / f.name)
                files.append(f.name)
    records.append(
        {
            "name": p["name"],
            "version": p["version"],
            "license": p.get("license"),
            "repository": p.get("repository"),
            "files": files,
        }
    )
(target / "manifest.json").write_text(json.dumps(records, indent=2) + "\n")
