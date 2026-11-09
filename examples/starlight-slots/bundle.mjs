/* global process, URL */
import { readFile } from 'node:fs/promises';

const entries = [['index.html', 'text/html'], ['style.css', 'text/css'], ['main.js', 'text/javascript'], ['rules.js', 'text/javascript']];
const files = await Promise.all(entries.map(async ([path, mime]) => ({ path, mime,
  content: (await readFile(new URL(path, import.meta.url))).toString('base64') })));
process.stdout.write(JSON.stringify({ type: 'bundle', entry: 'index.html', files }, null, 2) + '\n');
