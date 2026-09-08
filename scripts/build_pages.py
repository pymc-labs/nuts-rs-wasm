"""Assemble the public demo from the checksum-pinned release and current examples."""
import hashlib,json,shutil,subprocess,sys,tarfile,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
assets={'runtime':'dc73b5f69ef1946e3409f3ab0884a2b17a3f4d1956069ce0b70f0fc51665a6f4','adapter':'60f672d50c62031dc27e1f8098f1a63cdddff2e03da5afb0b1586cff246aeae9'}
with tempfile.TemporaryDirectory() as temp:
 for kind,digest in assets.items():
  name=f'nuts-rs-wasm-{kind}-v0.1.0.tar.gz';archive=Path(temp)/name
  subprocess.run(['curl','--fail','--location','--retry','3','--silent','--show-error',f'https://github.com/pymc-labs/nuts-rs-wasm/releases/download/v0.1.0/{name}','-o',str(archive)],check=True)
  assert hashlib.sha256(archive.read_bytes()).hexdigest()==digest,f'Checksum mismatch: {name}'
  with tarfile.open(archive) as tar:tar.extractall(out,filter='data')
# The old runtime archive bundles an earlier bootstrap. Pair it with the released adapter.
shutil.copy(out/'nuts/worker-loader.js',out/'runtime/nuts-worker-loader.js')
for name in ['notebook.html','marketing-mix-in-your-browser.ipynb']:shutil.copy(root/'examples'/name,out/name)
shutil.copytree(root/'examples/mmm',out/'mmm',dirs_exist_ok=True)
shutil.copy(root/'benchmarks/browser.html',out/'benchmark.html')
shutil.copytree(root/'benchmarks/2026-09-08',out/'benchmarks/2026-09-08',dirs_exist_ok=True,ignore=shutil.ignore_patterns('*.log','__pycache__'))
shutil.copy(root/'benchmarks/2026-09-08/mmm-performance.svg',out/'mmm-performance.svg')
# Notebook URLs encode model/data only in a fragment and execute only after a click.
(out/'.nojekyll').touch()
print('Static demo assembled:',out)
