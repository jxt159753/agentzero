import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'packages', 'agentzero');
const releases = join(root, '.local', 'plugin-releases');
await mkdir(releases, { recursive: true });
const marketplace = await mkdtemp(join(releases, 'agentzero-'));
const plugin = join(marketplace, 'plugins', 'agentzero');
await mkdir(plugin, { recursive: true });
const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
for (const entry of metadata.files) await cp(join(source, entry), join(plugin, entry), { recursive: true });
// Runtime is bundled; no install scripts, workspace paths or dependency install is needed.
const { name, version, type, description, engines, dsh } = metadata;
await writeFile(join(plugin, 'package.json'), JSON.stringify({ name, version, private: true, type, description, engines, dsh }, null, 2) + '\n');
await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true });
await writeFile(join(marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
  name: 'agentzero-local', interface: { displayName: 'AgentZero · Codex / DSH' },
  plugins: [{ name: 'agentzero', source: { source: 'local', path: './plugins/agentzero' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
}, null, 2) + '\n');
await writeFile(join(root, '.local', 'plugin-release.json'), JSON.stringify({ marketplace, plugin, version }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ marketplace, plugin, version }, null, 2) + '\n');
