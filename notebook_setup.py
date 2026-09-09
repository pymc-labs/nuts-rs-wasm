"""Restore the setuptools files omitted by Notebook.link's package filtering."""

import hashlib
import importlib
import json
import sys
import tempfile
import zipfile
from pathlib import Path


async def ensure_setuptools():
    if importlib.util.find_spec("setuptools.errors") is not None:
        return
    import pyjs

    root = Path(__file__).resolve().parent
    lock = json.loads((root / ".nblink/nblink-lock.json").read_text())
    wheel = next(p for p in lock["pipPackages"].values() if p["name"] == "setuptools")
    target = Path(tempfile.mkdtemp(prefix="nuts-setuptools-"))
    archive = target / "package.whl"
    download = pyjs.js.Function(
        "url",
        "path",
        """return (async () => {
      const response = await fetch(url);
      if (!response.ok) throw Error('Could not load setuptools');
      Module.FS.writeFile(path, new Uint8Array(await response.arrayBuffer()));
    })();""",
    )
    try:
        await download(wheel["url"], str(archive))
        if hashlib.sha256(archive.read_bytes()).hexdigest() != wheel["hash"]["sha256"]:
            raise ValueError("Setuptools wheel checksum mismatch")
        with zipfile.ZipFile(archive) as package:
            package.extractall(target)
    finally:
        archive.unlink(missing_ok=True)
    sys.path.insert(0, str(target))
    # Only discard the empty, filtered namespace, never an initialized package.
    if getattr(sys.modules.get("setuptools"), "__file__", None) is None:
        sys.modules.pop("setuptools", None)
    importlib.invalidate_caches()
