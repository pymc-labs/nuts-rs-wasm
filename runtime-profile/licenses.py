"""Collect original dependency notices from the exact public conda packages."""

import concurrent.futures
import io
import json
import subprocess
import tarfile
import zipfile
from contextlib import ExitStack
from pathlib import Path

import zstandard

ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "third-party-licenses"
TARGET.mkdir(exist_ok=True)
records = json.loads((ROOT / "resolved-environment.json").read_text())["packages"]


def collect(p):
    if p["build"] == "pip":
        return {
            "package": p["filename_stem"],
            "source": "dist-info licenses retained in runtime package archive",
        }
    stem = p["filename_stem"]
    dest = TARGET / stem
    if dest.exists():
        return json.loads((dest / "source.json").read_text())
    base = p["channel"].rstrip("/") + "/" + p["subdir"] + "/" + stem
    for ext in (".conda", ".tar.bz2"):
        url = base + ext
        response = subprocess.run(
            ["curl", "--fail", "--silent", "--location", "--max-time", "90", url],
            capture_output=True,
            check=False,
        )
        if response.returncode == 0:
            raw = response.stdout
            break
    else:
        raise RuntimeError("Original package unavailable: " + stem)
    with ExitStack() as stack:
        if ext == ".conda":
            z = zipfile.ZipFile(io.BytesIO(raw))
            name = next(n for n in z.namelist() if n.startswith("info-"))
            content = zstandard.ZstdDecompressor().stream_reader(
                io.BytesIO(z.read(name))
            )
            archive = stack.enter_context(tarfile.open(fileobj=content, mode="r|"))
        else:
            archive = stack.enter_context(
                tarfile.open(fileobj=io.BytesIO(raw), mode="r:bz2")
            )
        files = []
        index = {}
        for member in archive:
            if member.isfile() and (
                member.name.startswith("info/licenses/")
                or member.name == "info/index.json"
            ):
                data = archive.extractfile(member).read()
                if member.name == "info/index.json":
                    index = json.loads(data)
                else:
                    relative = Path(member.name).relative_to("info/licenses")
                    if ".." in relative.parts:
                        raise RuntimeError("Unsafe archive path")
                    out = dest / relative
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(data)
                    files.append(str(relative))
    dest.mkdir(exist_ok=True)
    record = {
        "package": stem,
        "url": url,
        "license": index.get("license"),
        "license_files": files,
    }
    (dest / "source.json").write_text(json.dumps(record, indent=2) + "\n")
    print(stem, len(files), flush=True)
    return record


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    result = list(pool.map(collect, records))
(TARGET / "manifest.json").write_text(json.dumps(result, indent=2) + "\n")
