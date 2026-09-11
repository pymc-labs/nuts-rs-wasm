import {execFileSync} from 'node:child_process';
import {copyFile, mkdir} from 'node:fs/promises';
execFileSync('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', 'adapter/Cargo.toml'], {stdio:'inherit'});
await mkdir('browser-artifact', {recursive:true});
for (const name of ['bridge.mjs','bridge-memory.mjs','client.mjs','tapewasm-client.mjs','tapewasm-runtime.mjs','tapewasm-worker.mjs','worker-loader.js','compile_model.py','results.py','configure-runtime.mjs','README.md','LICENSE']) await copyFile(name, `browser-artifact/${name}`);
const target = process.env.CARGO_TARGET_DIR ?? 'adapter/target';
await copyFile(`${target}/wasm32-unknown-unknown/release/nuts_browser_adapter.wasm`, 'browser-artifact/nuts_browser_adapter.wasm');
await copyFile('node_modules/comlink/dist/esm/comlink.mjs', 'browser-artifact/comlink.mjs');
await copyFile('node_modules/comlink/LICENSE', 'browser-artifact/COMLINK-LICENSE');

execFileSync('python3', ['scripts/rust_licenses.py'], {stdio:'inherit'});
