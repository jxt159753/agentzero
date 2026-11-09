import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'], outfile: 'dist/index.cjs',
  bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  sourcemap: false, legalComments: 'eof', metafile: true,
});

// Retain license files for the packages actually included in this bundle.
const packageRoots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const path = input.replaceAll('\\', '/');
  const marker = path.lastIndexOf('/node_modules/');
  if (marker < 0) continue;
  const packagePath = path.slice(marker + '/node_modules/'.length).split('/');
  const packageName = packagePath.slice(0, packagePath[0].startsWith('@') ? 2 : 1).join('/');
  packageRoots.add(resolve(root, path.slice(0, marker), 'node_modules', packageName));
}
const notices = [];
for (const directory of packageRoots) {
  const { name, version } = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(entry.name))
    .map(entry => entry.name).sort();
  if (files.length === 0) throw new Error(`Missing third-party license: ${name}@${version}`);
  const sections = await Promise.all(files.map(async file => `${file}\n\n${await readFile(join(directory, file), 'utf8')}`));
  notices.push({ name, text: `${name}@${version}\n${'='.repeat(72)}\n\n${sections.join('\n\n')}` });
}
notices.sort((left, right) => left.name.localeCompare(right.name));
await writeFile(join(root, 'dist', 'THIRD_PARTY_NOTICES.txt'),
  `Third-party licenses for the bundled AgentZero MCP runtime.\n\n${notices.map(notice => notice.text).join('\n\n')}\n`);
