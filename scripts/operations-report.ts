import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { economySnapshot } from '../apps/api/src/modules/ledger/service.js';

export interface ReportSource {
  environment: 'test' | 'development' | 'production';
  connection_variable: 'DATABASE_URL' | 'TEST_DATABASE_URL';
}

/** Aggregate existing records without changing budgets, reconciling, or exposing private content. */
export async function readOperationsReport(pool: pg.Pool, source: ReportSource) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const metadata = (await tx.query(`SELECT current_database() AS database, current_user AS role,
      transaction_timestamp() AS captured_at,
      to_char(transaction_timestamp() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-01') AS month,
      current_setting('transaction_read_only') AS read_only,
      current_setting('transaction_isolation') AS isolation`)).rows[0];
    if (metadata.role !== 'agentzero_app') throw new Error('Operations reports require the agentzero_app runtime role.');
    const month = metadata.month as string;
    const issuance = (await tx.query(`SELECT p.period IS NOT NULL AS configured,
      coalesce(p.limit_points,0)::text AS limit_points, coalesce(p.issued_points,0)::text AS issued_points,
      (coalesce(p.limit_points,0)-coalesce(p.issued_points,0))::text AS remaining_points
      FROM (SELECT $1::date AS month) m LEFT JOIN credit_issuance_periods p ON p.period=m.month`, [month])).rows[0];
    const rewardPool = (await tx.query(`SELECT status,total_quantity::text,allocated_quantity::text,
      user_monthly_limit::text, (length(contact_qq)>0) AS contact_configured,
      (length(btrim(instructions))>0) AS instructions_configured
      FROM reward_pools WHERE month=$1`, [month])).rows[0] ?? null;
    const rewardOffers = (await tx.query(`SELECT o.status,o.points_cost::text,count(*)::text AS offers,
      sum(o.total_quantity)::text AS total_quantity,sum(o.redeemed_quantity)::text AS redeemed_quantity,
      sum(o.total_quantity-o.redeemed_quantity)::text AS remaining_quantity
      FROM reward_offers o JOIN reward_pools p ON p.id=o.pool_id WHERE p.month=$1
      GROUP BY o.status,o.points_cost ORDER BY o.status,o.points_cost`, [month])).rows;
    const participation = (await tx.query(`SELECT
      (SELECT count(*)::text FROM users WHERE status='active') AS active_users,
      (SELECT count(*)::text FROM users WHERE status='pending') AS pending_users,
      (SELECT count(*)::text FROM users WHERE status='suspended') AS suspended_users,
      (SELECT count(*)::text FROM agents) AS agents,
      (SELECT count(*)::text FROM repositories r JOIN github_installations i USING(installation_id)
        WHERE r.status='approved' AND i.status='active' AND NOT r.is_private) AS usable_public_repositories`)).rows[0];
    const tasks = (await tx.query(`WITH participants AS (
        SELECT id AS task_id,assignee_agent_id AS agent_id FROM tasks WHERE status='settled'
        UNION SELECT t.id,m.agent_id FROM tasks t JOIN collaboration_agreements c ON c.task_id=t.id AND c.status='active'
          JOIN agreement_members m ON m.agreement_id=c.id WHERE t.status='settled'
      ), teams AS (
        SELECT p.task_id,count(*) AS agents,count(DISTINCT a.owner_user_id) AS owners
        FROM participants p JOIN agents a ON a.id=p.agent_id GROUP BY p.task_id
      ) SELECT count(*)::text AS total,
        count(*) FILTER(WHERE status='draft')::text AS draft,
        count(*) FILTER(WHERE status='open')::text AS open,
        count(*) FILTER(WHERE status='in_progress')::text AS in_progress,
        count(*) FILTER(WHERE status='submitted')::text AS submitted,
        count(*) FILTER(WHERE status='changes_requested')::text AS changes_requested,
        count(*) FILTER(WHERE status='settled')::text AS settled,
        count(*) FILTER(WHERE status='cancelled')::text AS cancelled,
        count(*) FILTER(WHERE disputed)::text AS currently_disputed,
        (SELECT count(DISTINCT agent_id)::text FROM participants) AS completed_agents,
        (SELECT count(*)::text FROM teams WHERE agents>1 AND owners>1) AS settled_cross_user_collaborations,
        (SELECT count(*)::text FROM teams WHERE agents>1 AND owners=1) AS settled_same_user_collaborations,
        (SELECT count(*)::text FROM task_reviews WHERE decision='request_changes') AS return_events,
        (SELECT count(DISTINCT task_id)::text FROM task_reviews WHERE decision='request_changes') AS returned_tasks,
        (SELECT count(DISTINCT task_id)::text FROM task_events WHERE kind IN ('disputed','deadline_disputed')) AS historically_disputed_tasks
      FROM tasks`)).rows[0];
    const market = (await tx.query(`SELECT
      (SELECT user_land_limit FROM market_settings WHERE id=1) AS user_land_limit,
      (SELECT count(*)::text FROM land_plots WHERE owner_agent_id IS NULL) AS unsold_lands,
      (SELECT count(*)::text FROM land_plots WHERE owner_agent_id IS NOT NULL) AS owned_lands,
      (SELECT count(*)::text FROM item_instances) AS item_instances,
      (SELECT count(*)::text FROM market_listings WHERE status='active') AS active_listings,
      (SELECT count(*)::text FROM market_trades WHERE land_id IS NOT NULL AND seller_agent_id IS NULL) AS initial_land_trades,
      (SELECT count(*)::text FROM market_trades WHERE item_id IS NOT NULL AND seller_agent_id IS NULL) AS initial_item_trades,
      (SELECT count(*)::text FROM market_trades WHERE land_id IS NOT NULL AND seller_agent_id IS NOT NULL) AS resale_land_trades,
      (SELECT count(*)::text FROM market_trades WHERE item_id IS NOT NULL AND seller_agent_id IS NOT NULL) AS resale_item_trades,
      (SELECT count(*)::text FROM market_trades t JOIN agents b ON b.id=t.buyer_agent_id
        JOIN agents s ON s.id=t.seller_agent_id WHERE b.owner_user_id<>s.owner_user_id) AS cross_user_resales,
      (SELECT coalesce(sum(points_price),0)::text FROM market_trades) AS traded_points`)).rows[0];
    const landSupply = (await tx.query(`SELECT points_price::text,count(*)::text AS quantity
      FROM land_plots WHERE owner_agent_id IS NULL GROUP BY points_price ORDER BY points_price`)).rows;
    const itemSupply = (await tx.query(`SELECT status,points_price::text,count(*)::text AS templates,
      sum(total_quantity-issued_quantity)::text AS remaining_quantity FROM item_templates
      GROUP BY status,points_price ORDER BY status,points_price`)).rows;
    const ledger = (await tx.query(`SELECT
      ((SELECT coalesce(sum(issued_points),0) FROM credit_issuance_periods)
        + (SELECT coalesce(sum(e.amount),0) FROM journal_entries e JOIN journal_transactions j ON j.id=e.transaction_id
           WHERE j.kind='INITIAL_GRANT' AND e.side='debit'))::text AS issued_points,
      (SELECT coalesce(sum(e.amount),0)::text FROM journal_entries e JOIN journal_transactions j ON j.id=e.transaction_id
        WHERE j.kind='INITIAL_GRANT' AND e.side='debit') AS initial_grant_points,
      (SELECT coalesce(sum(balance),0)::text FROM ledger_accounts WHERE bucket='USER_AVAILABLE') AS user_available_points,
      coalesce(sum(e.amount) FILTER(WHERE a.system_key='RECOVERY' AND e.side='debit'),0)::text AS recovered_gross_points,
      coalesce(sum(e.amount) FILTER(WHERE a.system_key='RECOVERY' AND e.side='credit' AND j.kind='REFUND'),0)::text AS refunded_points,
      coalesce(sum(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END) FILTER(WHERE a.system_key='RECOVERY'),0)::text AS recovered_net_points,
      (SELECT coalesce(sum(balance),0)::text FROM ledger_accounts WHERE bucket='AVAILABLE') AS agent_available_points,
      (SELECT coalesce(sum(balance),0)::text FROM ledger_accounts WHERE bucket IN ('RESERVED','USER_RESERVED','REWARD_RESERVED')) AS reserved_points,
      (SELECT balance::text FROM ledger_accounts WHERE system_key='REWARD_POOL') AS reward_pool_available_points,
      (SELECT count(*)::text FROM audit_events WHERE action='ledger.quarantined') AS quarantine_records
      FROM journal_entries e JOIN ledger_accounts a ON a.id=e.account_id JOIN journal_transactions j ON j.id=e.transaction_id`)).rows[0];
    const economy = await economySnapshot(tx);
    const rewards = (await tx.query(`SELECT status,count(*)::text AS claims,
      sum(points_cost)::text AS points, count(*) FILTER(WHERE fulfilled_at IS NOT NULL AND fulfillment_reference IS NOT NULL)::text AS recorded_fulfillments
      FROM reward_redemptions GROUP BY status ORDER BY status`)).rows;
    const webhooks = (await tx.query(`SELECT count(*)::text AS received,
      count(*) FILTER(WHERE status='processed')::text AS processed,
      count(*) FILTER(WHERE status='pending')::text AS pending,
      count(*) FILTER(WHERE status='pending' AND last_error IS NOT NULL)::text AS pending_with_error,
      min(created_at) FILTER(WHERE status='pending') AS oldest_pending_at
      FROM github_deliveries`)).rows[0];
    await tx.query('COMMIT');
    return {
      source: { ...source, ...metadata, time_zone: 'Asia/Shanghai' },
      scope: { configuration: 'current Shanghai month; market supply at snapshot', activity: 'all-time records in this database',
        provenance: 'Environment labels identify the connection, not whether each historical action was real. Keep fixtures in the test database.',
        fulfillment: 'Operator records do not independently verify offline payment.' },
      configuration: { issuance, reward_pool: rewardPool, reward_offers: rewardOffers, land_supply: landSupply, item_supply: itemSupply },
      participation, tasks, market, ledger, economy, rewards, webhooks,
      failed_transactions: { count: null, source: 'structured_request_logs',
        note: 'Rejected commands roll back their receipts. Group Request rejected/Request failed by route and error_code, then check request_id and business receipts; request retries are not distinct failed transactions.' },
    };
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally { tx.release(); }
}

export function reportConnection(args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.some(arg => arg !== '--test') || args.length > 1) throw new Error('Usage: operations-report.ts [--test]');
  const test = args.includes('--test');
  const variable = test ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const connectionString = env[variable];
  if (!connectionString) throw new Error(`${variable} is required.`);
  let database: string;
  try { database = new URL(connectionString).pathname.slice(1); }
  catch { throw new Error(`${variable} must be a PostgreSQL connection URL.`); }
  const namedTest = /(?:^|_)test(?:_|$)/i.test(database);
  if (test !== namedTest) throw new Error('Use --test only with an explicitly named test database; select it through TEST_DATABASE_URL.');
  return { connectionString, source: { environment: test ? 'test' : env.NODE_ENV === 'production' ? 'production' : 'development', connection_variable: variable } satisfies ReportSource };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let pool: pg.Pool | undefined;
  try {
    const { connectionString, source } = reportConnection(process.argv.slice(2));
    pool = new pg.Pool({ connectionString, max: 1 });
    process.stdout.write(`${JSON.stringify(await readOperationsReport(pool, source), null, 2)}\n`);
  } catch (error) {
    // Driver errors can contain server diagnostics. Do not print raw messages or connection URLs.
    const code = (error as { code?: unknown }).code;
    process.stderr.write(`Operations report failed${typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : ''}. Check the selected runtime connection, --test option and applied migrations.\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
