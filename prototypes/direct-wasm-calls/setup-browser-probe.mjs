// Reversible test-only routing. STATIC_ROOT must already serve runtime/ and nuts/.
import {readdir, mkdir, symlink, lstat} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = process.argv[2];
if (!root) throw Error('Usage: node setup-browser-probe.mjs STATIC_ROOT');
const staticRoot = resolve(root), prototype = fileURLToPath(new URL('.', import.meta.url));
const link = async (source, target) => {
  try {await lstat(target);}
  catch (error) {if(error.code !== 'ENOENT') throw error;await symlink(source,target);}
};
const runtime = join(staticRoot,'runtime'), route = join(staticRoot,'direct-runtime');
await mkdir(route,{recursive:true});
for (const name of await readdir(runtime)) {
  if(name !== 'nuts-worker-loader.js') await link(join(runtime,name),join(route,name));
}
await link(join(prototype,'worker-probe.js'),join(route,'nuts-worker-loader.js'));
await link(prototype,join(staticRoot,'direct-prototype'));
await link(fileURLToPath(new URL('../../examples/mmm/',import.meta.url)),join(staticRoot,'mmm'));
console.log('Open /direct-prototype/browser.html on the existing static server.');
