import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPool, withTransaction } from './index.js';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required; runtime credentials cannot migrate.');
const pool = createPool(url);
try {
  await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ current_user: string; server_version_num: string }>(
      "SELECT current_user, current_setting('server_version_num') AS server_version_num",
    );
    if (rows[0]?.current_user !== 'agentzero_migrator') throw new Error('Migrations require agentzero_migrator.');
    if (!rows[0] || Number(rows[0].server_version_num) < 180000 || Number(rows[0].server_version_num) >= 190000) {
      throw new Error('PostgreSQL 18 is required.');
    }
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('agentzero:migrations'))");
    await tx.query(`CREATE TABLE IF NOT EXISTS public._migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const content = await readFile(`${directory}/${file}`, 'utf8');
      const checksum = createHash('sha256').update(content).digest('hex');
      const existing = await tx.query<{ checksum: string }>('SELECT checksum FROM public._migrations WHERE name = $1', [file]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${file}`);
        continue;
      }
      await tx.query(content);
      await tx.query('INSERT INTO public._migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
      process.stdout.write(`Applied ${file}\n`);
    }
  });
} finally {
  await pool.end();
}
