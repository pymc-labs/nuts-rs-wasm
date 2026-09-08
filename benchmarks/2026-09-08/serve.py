from pathlib import Path
import http.server, json, os, sys, tempfile, shutil
repo=Path(__file__).resolve().parents[2]
source=Path(sys.argv[1]).resolve()
port=int(sys.argv[2]) if len(sys.argv)>2 else 8769
root=Path(tempfile.mkdtemp(prefix='mmm-benchmark-'))
(root/'nuts').symlink_to(repo/'browser-artifact',target_is_directory=True)
(root/'mmm').symlink_to(repo/'examples/mmm',target_is_directory=True)
runtime=root/'runtime';runtime.mkdir()
for p in source.iterdir():
    if p.name=='nuts-worker-loader.js':shutil.copy(repo/'worker-loader.js',runtime/p.name)
    else:(runtime/p.name).symlink_to(p,target_is_directory=p.is_dir())
shutil.copy(Path(__file__).with_name('browser.html'),root/'benchmark.html')
class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path!='/save':self.send_error(404);return
        data=self.rfile.read(int(self.headers['Content-Length']));json.loads(data)
        (repo/'benchmarks/2026-09-08/browser.json').write_bytes(data)
        self.send_response(200);self.end_headers();self.wfile.write(b'ok')
    def log_message(self,*args):pass
os.chdir(root)
http.server.ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()
