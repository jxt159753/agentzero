import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const source = process.env.TEST_MIGRATION_DATABASE_URL;
if (!source) throw new Error('TEST_MIGRATION_DATABASE_URL is required.');
const sourceUrl = new URL(source);
if (!sourceUrl.pathname.endsWith('_test')) throw new Error('Backup verification requires an isolated _test database.');
const binaryDirectory = process.env.PG_BIN ?? resolve('.local/postgresql18/pgsql/bin');
const localDirectory = resolve('.local');
const restoreName = `agentzero_restore_${Date.now()}`;
const dumpPath = resolve(localDirectory, `${restoreName}.dump`);
await mkdir(localDirectory, { recursive: true });

async function cli(command: string, args: string[], url: URL): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn(resolve(binaryDirectory, `${command}${process.platform === 'win32' ? '.exe' : ''}`), args, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1),
      },
    });
    let diagnostic = '';
    child.stderr.on('data', (chunk: Buffer) => { diagnostic += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? done() : reject(new Error(`${command} exited ${code}: ${diagnostic}`)));
  });
}

const adminUrl = new URL(sourceUrl);
adminUrl.username = 'postgres';
adminUrl.password = (await readFile(resolve(localDirectory, 'pwfile'), 'utf8')).trim();
adminUrl.pathname = '/postgres';
if (sourceUrl.hostname !== '127.0.0.1' || sourceUrl.port !== '55432') {
  throw new Error('This restore verification uses only the project-local PostgreSQL on 127.0.0.1:55432.');
}
const admin = new pg.Pool({ connectionString: adminUrl.toString() });
await cli('pg_dump', ['--format=custom', '--file', dumpPath], sourceUrl);
try {
  await admin.query(`CREATE DATABASE "${restoreName}" OWNER agentzero_migrator`);
} finally { await admin.end(); }
const restoreUrl = new URL(sourceUrl);
restoreUrl.pathname = `/${restoreName}`;
await cli('pg_restore', ['--exit-on-error', '--dbname', restoreName, dumpPath], restoreUrl);

const sourcePool = new pg.Pool({ connectionString: sourceUrl.toString() });
const restoredPool = new pg.Pool({ connectionString: restoreUrl.toString() });
const runtimeUrl = new URL(process.env.TEST_DATABASE_URL ?? '');
runtimeUrl.pathname = `/${restoreName}`;
const runtime = new pg.Pool({ connectionString: runtimeUrl.toString() });
try {
  const query = `SELECT
    (SELECT count(*)::text FROM public.ledger_accounts) AS accounts,
    (SELECT count(*)::text FROM public.journal_transactions) AS transactions,
    (SELECT count(*)::text FROM public.journal_entries) AS entries,
    (SELECT coalesce(sum(balance), 0)::text FROM public.ledger_accounts WHERE normal_side = 'debit') AS debit_balances,
    (SELECT coalesce(sum(balance), 0)::text FROM public.ledger_accounts WHERE normal_side = 'credit') AS credit_balances,
    ((SELECT coalesce(sum(issued_points), 0) FROM public.credit_issuance_periods)
      + (SELECT coalesce(sum(e.amount), 0) FROM public.journal_entries e JOIN public.journal_transactions j ON j.id=e.transaction_id
         WHERE j.kind='INITIAL_GRANT' AND e.side='debit'))::text AS issued,
    (SELECT count(*)::text FROM public.reward_redemptions) AS reward_redemptions,
    (SELECT md5(coalesce(string_agg(row_to_json(p)::text, '' ORDER BY p.id), '')) FROM public.reward_pools p) AS reward_pools_hash,
    (SELECT md5(coalesce(string_agg(row_to_json(o)::text, '' ORDER BY o.id), '')) FROM public.reward_offers o) AS reward_offers_hash,
    (SELECT md5(coalesce(string_agg(row_to_json(r)::text, '' ORDER BY r.id), '')) FROM public.reward_redemptions r) AS reward_redemptions_hash,
    (SELECT count(*)::text FROM public.market_trades) AS market_trades,
    (SELECT md5(coalesce(string_agg(row_to_json(s)::text, '' ORDER BY s.id), '')) FROM public.market_settings s) AS market_settings_hash,
    (SELECT md5(coalesce(string_agg(row_to_json(l)::text, '' ORDER BY l.id), '')) FROM public.land_plots l) AS land_plots_hash,
    (SELECT md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY t.id), '')) FROM public.item_templates t) AS item_templates_hash,
    (SELECT md5(coalesce(string_agg(row_to_json(i)::text, '' ORDER BY i.id), '')) FROM public.item_instances i) AS item_instances_hash,
    (SELECT md5(coalesce(string_agg(row_to_json(l)::text, '' ORDER BY l.id), '')) FROM public.market_listings l) AS market_listings_hash,
    (SELECT md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY t.id), '')) FROM public.market_trades t) AS market_trades_hash,
    (SELECT count(*)::text FROM public.world_positions) AS world_positions,
    (SELECT count(*)::text FROM public.world_publications) AS world_publications,
    (SELECT md5(coalesce(string_agg(row_to_json(p)::text, '' ORDER BY p.kind,p.subject_id), '')) FROM public.world_positions p) AS world_positions_hash,
    (SELECT md5(coalesce(string_agg(row_to_json(p)::text, '' ORDER BY p.agent_id,p.task_id), '')) FROM public.world_publications p) AS world_publications_hash`;
  const before = (await sourcePool.query(query)).rows[0] as Record<string, string>;
  const after = (await restoredPool.query(query)).rows[0] as Record<string, string>;
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Restored ledger summary differs from source.');
  if (after.debit_balances !== after.credit_balances || after.credit_balances !== after.issued) {
    throw new Error('Restored aggregate ledger conservation failed.');
  }
  const cacheDifferences = await runtime.query(`SELECT a.id FROM public.ledger_accounts a
    LEFT JOIN public.journal_entries e ON e.account_id = a.id GROUP BY a.id
    HAVING a.balance::numeric <> coalesce(sum(CASE WHEN e.side = a.normal_side THEN e.amount::numeric ELSE -e.amount::numeric END), 0)`);
  const holdDifferences = await runtime.query(`SELECT a.id FROM public.ledger_accounts a
    LEFT JOIN public.credit_holds h ON h.reserved_account_id = a.id AND h.status = 'open'
    WHERE a.bucket IN ('RESERVED', 'USER_RESERVED', 'REWARD_RESERVED') GROUP BY a.id
    HAVING a.balance::numeric <> coalesce(sum(h.reserved_total::numeric - h.captured_total::numeric - h.released_total::numeric), 0)`);
  if (cacheDifferences.rowCount || holdDifferences.rowCount) throw new Error('Restored account or hold reconciliation failed.');
  const permissions = (await runtime.query(`SELECT
    has_table_privilege(current_user, 'public.journal_entries', 'INSERT') AS can_insert_entries,
    has_column_privilege(current_user, 'public.ledger_accounts', 'balance', 'UPDATE') AS can_update_balance,
    has_column_privilege(current_user, 'public.agents', 'owner_user_id', 'UPDATE') AS can_change_owner,
    has_function_privilege(current_user, 'ledger.post_journal(jsonb,jsonb)', 'EXECUTE') AS can_post`)).rows[0] as Record<string, boolean>;
  if (permissions.can_insert_entries || permissions.can_update_balance || permissions.can_change_owner || !permissions.can_post) {
    throw new Error('Restored runtime permissions differ from required ledger boundary.');
  }
  const report = { verifiedAt: new Date().toISOString(), sourceDatabase: sourceUrl.pathname.slice(1), restoredDatabase: restoreName,
    dumpPath, ledger: after, permissions, accountDifferences: cacheDifferences.rowCount, holdDifferences: holdDifferences.rowCount };
  await writeFile(resolve(localDirectory, 'backup-restore-result.json'), JSON.stringify(report, null, 2));
  console.log(`Backup restored and verified in ${restoreName}; report: .local/backup-restore-result.json`);
} finally {
  await Promise.all([sourcePool.end(), restoredPool.end(), runtime.end()]);
}
