import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createPool, withTransaction, type Tx } from '../../packages/database/src/index.js';
import type { Actor } from '../../packages/contracts/src/index.js';
import { hash, lockActor, runCommand } from '../../apps/api/src/core.js';
import { finalizeHold, issue, reserve, setIssuanceLimit, type LedgerContext } from '../../apps/api/src/modules/ledger/service.js';

export function testPools() {
  const runtimeUrl = process.env.TEST_DATABASE_URL;
  const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!runtimeUrl || !migrationUrl) throw new Error('TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL are required; PostgreSQL 18 integration tests never use a mock.');
  const runtime = new URL(runtimeUrl);
  const migration = new URL(migrationUrl);
  if (!/test/i.test(runtime.pathname) || runtime.pathname !== migration.pathname || runtime.host !== migration.host) throw new Error('Integration tests require one explicitly named test database and separate roles.');
  if (process.env.DATABASE_URL) {
    const development = new URL(process.env.DATABASE_URL);
    if (development.host === runtime.host && development.pathname === runtime.pathname) throw new Error('Test and development databases must differ.');
  }
  return { runtime: createPool(runtimeUrl), migration: createPool(migrationUrl) };
}

export async function resetLedgerTestData(migration: pg.Pool) {
  await migration.query(`TRUNCATE public.audit_events,public.idempotency_requests,public.journal_entries,public.journal_transactions,
    public.credit_holds,public.credit_issuance_periods,public.agent_keys,public.agent_policies,public.user_sessions,
    public.oauth_login_states,public.ledger_accounts,public.agents,public.users,
    public.github_deliveries,public.repositories,public.github_installations CASCADE;
    INSERT INTO public.ledger_accounts(system_key,bucket,normal_side) VALUES
      ('REWARD_POOL','REWARD_POOL','debit'),('REWARD_RESERVED','REWARD_RESERVED','debit'),
      ('RECOVERY','RECOVERY','debit'),('ISSUANCE_CONTROL','ISSUANCE_CONTROL','credit');
    UPDATE public.market_settings SET user_land_limit=3,version=1,default_land_supplied=false;
    UPDATE public.contribution_reward_settings SET commit_points=0,pull_request_points=0,issue_points=0,version=1`);
}

let githubSequence = 500000;
export async function identity(pool: pg.Pool, role: 'admin' | 'member' = 'member') {
  return withTransaction(pool, async (tx) => {
    const userId = randomUUID(); const sessionId = randomUUID();
    await tx.query("INSERT INTO public.users(id,github_user_id,github_login,display_name,status,role) VALUES($1,$2,$3,$3,'active',$4)", [userId, String(++githubSequence), `fixture-${userId}`, role]);
    await tx.query("INSERT INTO public.user_sessions(id,user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '7 days')", [sessionId, userId, hash(randomBytes(32).toString('hex')), hash(randomBytes(32).toString('hex'))]);
    const actor: Actor = { type: 'user', userId, sessionId };
    return actor;
  });
}

export async function agent(pool: pg.Pool, owner: Actor, limits = '1000') {
  if (owner.type !== 'user') throw new Error('User required');
  return withTransaction(pool, async (tx) => {
    const id = randomUUID(); const credentialId = randomUUID();
    await tx.query("INSERT INTO public.agents(id,owner_user_id,name) VALUES($1,$2,'Ledger test Agent')", [id, owner.userId]);
    await tx.query('INSERT INTO public.agent_policies(agent_id,can_accept_task,can_collaborate,can_trade,can_redeem_api,single_spend_limit,daily_spend_limit) VALUES($1,true,true,true,true,$2,$2)', [id, limits]);
    await tx.query('SELECT ledger.open_agent_accounts($1)', [id]);
    await tx.query("INSERT INTO public.agent_keys(id,agent_id,label,secret_hash) VALUES($1,$2,'fixture',$3)", [credentialId, id, hash(randomBytes(32).toString('hex'))]);
    return { id, owner, actor: { type: 'agent', agentId: id, ownerUserId: owner.userId, credentialId } satisfies Actor };
  });
}

export const context = (actor: Actor): LedgerContext => ({ actor, requestId: randomUUID() });

export async function command<T extends Record<string, unknown>>(
  pool: pg.Pool, actor: Actor, agentId: string | undefined, route: string, payload: unknown,
  action: (tx: Tx, ctx: LedgerContext) => Promise<T>, key = randomUUID(),
) {
  const ctx = context(actor);
  return runCommand(pool, actor, { route, key, payload, requestId: ctx.requestId, agentId }, async (tx) => ({ status: 200, body: await action(tx, ctx) }));
}

export async function fund(pool: pg.Pool, administrator: Actor, targetAgentId: string, amount: string) {
  await withTransaction(pool, async (tx) => {
    await lockActor(tx, administrator, { admin: true });
    const month = (await tx.query<{ month: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month")).rows[0]!.month;
    const ctx = context(administrator);
    await setIssuanceLimit(tx, ctx, { month, limitPoints: '9223372036854775807', reason: 'isolated test budget' });
    await issue(tx, ctx, { businessKey: `test-issue:${randomUUID()}`, amount, reason: 'isolated test issue' });
    const hold = await reserve(tx, ctx, { businessRef: `test-reward:${randomUUID()}`, payerAgentId: null, amount, permission: 'can_accept_task', reason: 'test reward reserve' });
    await finalizeHold(tx, ctx, { holdId: String(hold.holdId), payments: [{ agentId: targetAgentId, amount }], refund: '0', reason: 'test reward settlement' });
  });
}

/** Each contender owns a different PostgreSQL connection before the start gate opens. */
export async function concurrent<T>(pool: pg.Pool, work: { actor: Actor; agentId?: string; action: (tx: Tx, ctx: LedgerContext) => Promise<T> }[]) {
  const clients = await Promise.all(work.map(() => pool.connect()));
  let start!: () => void;
  const gate = new Promise<void>((resolve) => { start = resolve; });
  const tasks = work.map(async (item, index) => {
    const tx = clients[index]!;
    await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      await gate;
      await lockActor(tx, item.actor, { agentId: item.agentId });
      const result = await item.action(tx, context(item.actor));
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally { tx.release(); }
  });
  start();
  return Promise.allSettled(tasks);
}
