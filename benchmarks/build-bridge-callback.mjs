import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
execFileSync('rustc', ['--edition=2021', '--crate-type=cdylib', '--target', 'wasm32-unknown-unknown',
  '-O', '-C', 'panic=abort', fileURLToPath(new URL('./bridge-callback.rs', import.meta.url)),
  '-o', fileURLToPath(new URL('./bridge-callback.wasm', import.meta.url))], {stdio: 'inherit'});
