import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction, type Tx } from '../../packages/database/src/index.js';
import type { Actor } from '../../packages/contracts/src/index.js';
import { lockActor } from '../../apps/api/src/core.js';
import { adjustHold, finalizeHold, getWallet, issue, pay, reconcile, refund, reserve, setIssuanceLimit } from '../../apps/api/src/modules/ledger/service.js';
import { agent, command, concurrent, context, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools();
const system: Actor = { type: 'system' };
let admin: Actor;
let owner: Actor;
let payer: Awaited<ReturnType<typeof agent>>;
let recipient: Awaited<ReturnType<typeof agent>>;
const read = <T>(work: (tx: Tx) => Promise<T>) => withTransaction(pools.runtime, work);
const wallet = (id = payer.id) => read((tx) => getWallet(tx, id));
const reserveInput = (amount: string, businessRef = randomUUID()) => ({ businessRef, payerAgentId: payer.id, amount, permission: 'can_trade' as const, reason: 'test commitment' });
const reserveFor = async (amount: string, ref = randomUUID()) => {
  const input = reserveInput(amount, ref);
  return read(async (tx) => { await lockActor(tx, owner, { agentId: payer.id }); return reserve(tx, context(owner), input); });
};

describe('PostgreSQL 18 ledger acceptance (T03, T05–T12)', () => {
  beforeAll(async () => {
    const version = await pools.runtime.query<{ server_version_num: string }>('SHOW server_version_num');
    expect(Number(version.rows[0]!.server_version_num)).toBeGreaterThanOrEqual(180000);
    expect(Number(version.rows[0]!.server_version_num)).toBeLessThan(190000);
    expect((await pools.runtime.query('SELECT current_user')).rows[0].current_user).toBe('agentzero_app');
  });
  beforeEach(async () => {
    await resetLedgerTestData(pools.migration);
    admin = await identity(pools.runtime, 'admin'); owner = await identity(pools.runtime);
    payer = await agent(pools.runtime, owner); recipient = await agent(pools.runtime, await identity(pools.runtime));
  });
  afterAll(async () => { await pools.runtime.end(); await pools.migration.end(); });

  it('T05 serializes monthly issuance and replays the business under a new request key', async () => {
    const secondAdmin = await identity(pools.runtime, 'admin');
    const month = (await pools.runtime.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS value")).rows[0].value as string;
    await command(pools.runtime, admin, undefined, 'test/budget', {}, (tx, ctx) => setIssuanceLimit(tx, ctx, { month, limitPoints: '100', reason: 'test budget' }));
    const inputs = [0, 1].map(() => ({ businessKey: `test:${randomUUID()}`, amount: '80', reason: 'test issue' }));
    const results = await concurrent(pools.runtime, [admin, secondAdmin].map((actor, index) => ({ actor, action: (tx, ctx) => issue(tx, ctx, inputs[index]!) })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    const replay = await command(pools.runtime, winner === 0 ? admin : secondAdmin, undefined, 'test/issue', inputs[winner], (tx, ctx) => issue(tx, ctx, inputs[winner]!));
    expect(replay.body.created).toBe(false);
    expect((await pools.runtime.query('SELECT issued_points FROM public.credit_issuance_periods')).rows[0].issued_points).toBe('80');
    expect((await pools.runtime.query("SELECT count(*)::text AS count FROM public.journal_transactions WHERE kind='ISSUE'")).rows[0].count).toBe('1');
    expect((await read((tx) => reconcile(tx))).ok).toBe(true);
  });

  it.each(['balance', 'daily limit'])('T06 allows one of two concurrent 80-point holds constrained by %s', async (constraint) => {
    await fund(pools.runtime, admin, payer.id, constraint === 'balance' ? '100' : '200');
    if (constraint === 'daily limit') await pools.runtime.query('UPDATE public.agent_policies SET daily_spend_limit=100 WHERE agent_id=$1', [payer.id]);
    const results = await concurrent(pools.runtime, [0, 1].map(() => ({ actor: owner, agentId: payer.id, action: (tx, ctx) => reserve(tx, ctx, reserveInput('80')) })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await wallet()).toMatchObject({ available: constraint === 'balance' ? '20' : '120', reserved: '80', dailyUsed: '80' });
    expect((await pools.runtime.query('SELECT count(*)::text AS count FROM public.credit_holds WHERE payer_agent_id=$1', [payer.id])).rows[0].count).toBe('1');
    expect((await read((tx) => reconcile(tx))).ok).toBe(true);
  });

  it('T07 serializes finalize against cancel and does not pay twice under a new request key', async () => {
    await fund(pools.runtime, admin, payer.id, '100');
    const hold = await reserveFor('100');
    const inputs = [
      { holdId: String(hold.holdId), payments: [{ agentId: recipient.id, amount: '70' }], refund: '30', reason: 'settle' },
      { holdId: String(hold.holdId), payments: [], refund: '100', reason: 'cancel' },
    ];
    const results = await concurrent(pools.runtime, inputs.map((input) => ({ actor: system, action: (tx, ctx) => finalizeHold(tx, ctx, input) })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    const replay = await command(pools.runtime, system, undefined, 'test/finalize', inputs[winner], (tx, ctx) => finalizeHold(tx, ctx, inputs[winner]!));
    expect(replay.body.created).toBe(false);
    expect(await wallet()).toMatchObject({ available: winner === 0 ? '30' : '100', reserved: '0', dailyUsed: winner === 0 ? '70' : '0' });
    expect(await wallet(recipient.id)).toMatchObject({ available: winner === 0 ? '70' : '0' });
    const stored = (await pools.runtime.query('SELECT * FROM public.credit_holds WHERE id=$1', [hold.holdId])).rows[0];
    expect(stored.status).toBe('closed');
    expect((await pools.runtime.query('SELECT count(*)::text AS count FROM public.journal_transactions WHERE business_key=$1', [`hold:${hold.holdId}:finalize`])).rows[0].count).toBe('1');
    expect((await read((tx) => reconcile(tx))).ok).toBe(true);
  });

  it('T08 rolls back balances, hold, journal, audit and receipt if the enclosing domain command fails', async () => {
    await fund(pools.runtime, admin, payer.id, '100');
    const hold = await reserveFor('100');
    const input = { holdId: String(hold.holdId), payments: [{ agentId: recipient.id, amount: '70' }], refund: '30', reason: 'settle' };
    const key = randomUUID();
    await expect(command(pools.runtime, system, undefined, 'test/rollback', input, async (tx, ctx) => {
      await finalizeHold(tx, ctx, input); throw new Error('enclosing domain failed');
    }, key)).rejects.toThrow('enclosing domain failed');
    expect(await wallet()).toMatchObject({ available: '0', reserved: '100', dailyUsed: '100' });
    expect(await wallet(recipient.id)).toMatchObject({ available: '0' });
    expect((await pools.runtime.query('SELECT status FROM public.credit_holds WHERE id=$1', [hold.holdId])).rows[0].status).toBe('open');
    expect((await pools.runtime.query('SELECT count(*)::text AS count FROM public.journal_transactions WHERE business_key=$1', [`hold:${hold.holdId}:finalize`])).rows[0].count).toBe('0');
    expect((await pools.runtime.query('SELECT count(*)::text AS count FROM public.idempotency_requests WHERE idempotency_key=$1', [key])).rows[0].count).toBe('0');
    const settled = await command(pools.runtime, system, undefined, 'test/rollback', input, (tx, ctx) => finalizeHold(tx, ctx, input), key);
    expect(settled.body.created).toBe(true);
    expect(await wallet()).toMatchObject({ available: '30', reserved: '0', todaySpent: '70' });
    expect(await wallet(recipient.id)).toMatchObject({ available: '70' });
    expect((await read((tx) => reconcile(tx))).ok).toBe(true);
  });

  it('settles 100 points directly to two recipients as 70 and 30', async () => {
    await fund(pools.runtime, admin, payer.id, '100');
    const collaborator = await agent(pools.runtime, await identity(pools.runtime));
    const hold = await reserveFor('100');
    await read((tx) => finalizeHold(tx, context(system), { holdId: String(hold.holdId), payments: [{ agentId: recipient.id, amount: '70' }, { agentId: collaborator.id, amount: '30' }], refund: '0', reason: 'agreed collaboration split' }));
    expect(await wallet()).toMatchObject({ available: '0', reserved: '0', todaySpent: '100' });
    expect(await wallet(recipient.id)).toMatchObject({ available: '70' });
    expect(await wallet(collaborator.id)).toMatchObject({ available: '30' });
    expect((await read((tx) => reconcile(tx))).ok).toBe(true);
  });

  it('rolls back zero-balance account opening with its enclosing Agent creation', async () => {
    const id = randomUUID();
    if (owner.type !== 'user') throw new Error('fixture owner must be user');
    const ownerId = owner.userId;
    await expect(read(async (tx) => {
      await tx.query("INSERT INTO public.agents(id,owner_user_id,name) VALUES($1,$2,'rollback agent')", [id, ownerId]);
      await tx.query('INSERT INTO public.agent_policies(agent_id) VALUES($1)', [id]);
      await tx.query('SELECT ledger.open_agent_accounts($1)', [id]);
      expect((await tx.query('SELECT count(*)::text AS count FROM public.ledger_accounts WHERE agent_id=$1', [id])).rows[0].count).toBe('2');
      throw new Error('fail after opening');
    })).rejects.toThrow('fail after opening');
    expect((await pools.runtime.query('SELECT count(*)::text AS count FROM public.ledger_accounts WHERE agent_id=$1', [id])).rows[0].count).toBe('0');
    expect((await pools.runtime.query('SELECT count(*)::text AS count FROM public.agents WHERE id=$1', [id])).rows[0].count).toBe('0');
  });

  it('T09 counts yesterday’s open holds today and replaces reservation with actual settlement', async () => {
    await fund(pools.runtime, admin, payer.id, '200');
    const oldHold = await reserveFor('80');
    // Only the isolated migration fixture can set a historical date; production has no such input.
    await pools.migration.query("UPDATE public.journal_transactions SET business_date=(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date-1 WHERE id=$1", [oldHold.transactionId]);
    await pools.runtime.query('UPDATE public.agent_policies SET daily_spend_limit=100 WHERE agent_id=$1', [payer.id]);
    const payInput = { businessKey: `test:${randomUUID()}`, payerAgentId: payer.id, amount: '10', permission: 'can_trade' as const, reason: 'today spend' };
    await command(pools.runtime, owner, payer.id, 'test/pay', payInput, (tx, ctx) => pay(tx, ctx, payInput));
    expect(await wallet()).toMatchObject({ dailyUsed: '90', todaySpent: '10', outstandingHeld: '80' });
    await expect(reserveFor('11')).rejects.toMatchObject({ code: 'SPEND_LIMIT_EXCEEDED' });
    const lastTen = await reserveFor('10');
    expect(await wallet()).toMatchObject({ dailyUsed: '100' });
    await read((tx) => finalizeHold(tx, context(system), { holdId: String(lastTen.holdId), payments: [], refund: '10', reason: 'cancel temporary commitment' }));
    await read((tx) => finalizeHold(tx, context(system), { holdId: String(oldHold.holdId), payments: [{ agentId: recipient.id, amount: '60' }], refund: '20', reason: 'settle prior day contract' }));
    expect(await wallet()).toMatchObject({ dailyUsed: '70', todaySpent: '70', outstandingHeld: '0', reserved: '0' });
    expect((await read((tx) => reconcile(tx))).ok).toBe(true);
  });

  it('T10 checks total commitment after each adjustment and honors old obligations after limits drop', async () => {
    await fund(pools.runtime, admin, payer.id, '200');
    await pools.runtime.query('UPDATE public.agent_policies SET single_spend_limit=100,daily_spend_limit=100 WHERE agent_id=$1', [payer.id]);
    const hold = await reserveFor('80');
    const adjust = (amount: string, revision = randomUUID()) => {
      const input = { holdId: String(hold.holdId), amount, revision, permission: 'can_trade' as const, reason: 'revise commitment' };
      return command(pools.runtime, owner, payer.id, 'test/adjust', input, (tx, ctx) => adjustHold(tx, ctx, input));
    };
    await adjust('100');
    await expect(adjust('120')).rejects.toMatchObject({ code: 'SPEND_LIMIT_EXCEEDED' });
    await adjust('80'); await adjust('100');
    expect((await pools.runtime.query('SELECT reserved_total,released_total FROM public.credit_holds WHERE id=$1', [hold.holdId])).rows[0]).toMatchObject({ reserved_total: '120', released_total: '20' });
    await pools.runtime.query('UPDATE public.agent_policies SET single_spend_limit=50,daily_spend_limit=50,can_trade=false WHERE agent_id=$1', [payer.id]);
    await expect(reserveFor('1')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await read((tx) => finalizeHold(tx, context(system), { holdId: String(hold.holdId), payments: [{ agentId: recipient.id, amount: '70' }], refund: '30', reason: 'perform old contract' }));
    expect(await wallet()).toMatchObject({ dailyUsed: '70', available: '130', reserved: '0' });
    expect((await read((tx) => reconcile(tx))).ok).toBe(true);
  });

  it('refunds never replenish the original daily spending allowance and cannot exceed payment', async () => {
    await fund(pools.runtime, admin, payer.id, '100');
    const input = { businessKey: `test:${randomUUID()}`, payerAgentId: payer.id, amount: '40', permission: 'can_trade' as const, reason: 'purchase' };
    const payment = await command(pools.runtime, owner, payer.id, 'test/pay', input, (tx, ctx) => pay(tx, ctx, input));
    const refundInput = { businessKey: `test-refund:${randomUUID()}`, originalTransactionId: String(payment.body.transactionId), amount: '20', reason: 'return unused service' };
    await command(pools.runtime, system, undefined, 'test/refund', refundInput, (tx, ctx) => refund(tx, ctx, refundInput));
    expect(await wallet()).toMatchObject({ available: '80', todaySpent: '40', dailyUsed: '40' });
    await expect(command(pools.runtime, system, undefined, 'test/refund', {}, (tx, ctx) => refund(tx, ctx, { ...refundInput, businessKey: randomUUID(), amount: '21' }))).rejects.toMatchObject({ code: 'INVALID_REFUND' });
    expect((await read((tx) => reconcile(tx))).ok).toBe(true);
  });

  it.each(['credential', 'agent', 'user'])('T03 rejects a new operation waiting behind %s revocation but system fulfillment remains valid', async (target) => {
    await fund(pools.runtime, admin, payer.id, '100');
    const hold = await reserveFor('80');
    const revoker = await pools.runtime.connect();
    await revoker.query('BEGIN');
    await lockActor(revoker, owner, { agentId: payer.id });
    if (target === 'credential') await revoker.query('UPDATE public.agent_keys SET revoked_at=clock_timestamp() WHERE id=$1', [payer.actor.credentialId]);
    if (target === 'agent') await revoker.query("UPDATE public.agents SET status='paused' WHERE id=$1", [payer.id]);
    if (target === 'user') await revoker.query("UPDATE public.users SET status='suspended' WHERE id=$1", [payer.actor.ownerUserId]);
    const input = reserveInput('1');
    const newRequest = command(pools.runtime, payer.actor, payer.id, 'test/reserve', input, (tx, ctx) => reserve(tx, ctx, input));
    await revoker.query('COMMIT'); revoker.release();
    await expect(newRequest).rejects.toMatchObject({ code: target === 'credential' ? 'CREDENTIAL_REVOKED' : target === 'agent' ? 'AGENT_PAUSED' : 'ACCOUNT_SUSPENDED' });
    await read((tx) => finalizeHold(tx, context(system), { holdId: String(hold.holdId), payments: [{ agentId: recipient.id, amount: '60' }], refund: '20', reason: 'honor contract' }));
    expect(await wallet()).toMatchObject({ available: '40', reserved: '0', todaySpent: '60' });
    expect(await wallet(recipient.id)).toMatchObject({ available: '60' });
  });

  it('T11 forbids direct ledger writes and rejects malformed journals atomically', async () => {
    await fund(pools.runtime, admin, payer.id, '100');
    const rows = (await pools.runtime.query('SELECT id,bucket FROM public.ledger_accounts')).rows as { id: string; bucket: string }[];
    const available = (await pools.runtime.query("SELECT id FROM public.ledger_accounts WHERE agent_id=$1 AND bucket='AVAILABLE'", [payer.id])).rows[0].id as string;
    const recovery = rows.find((row) => row.bucket === 'RECOVERY')!.id;
    const control = rows.find((row) => row.bucket === 'ISSUANCE_CONTROL')!.id;
    await expect(pools.runtime.query('UPDATE public.ledger_accounts SET balance=999 WHERE id=$1', [available])).rejects.toMatchObject({ code: '42501' });
    await expect(pools.runtime.query("INSERT INTO public.journal_transactions(kind,business_key,payload_hash,actor_type,business_date,reason) VALUES('PAY','bad',decode('aa','hex'),'system',current_date,'bad')")).rejects.toMatchObject({ code: '42501' });
    const existing = (await pools.runtime.query('SELECT id FROM public.journal_transactions LIMIT 1')).rows[0].id as string;
    await expect(pools.runtime.query("INSERT INTO public.journal_entries(transaction_id,line_no,account_id,side,amount) VALUES($1,99,$2,'debit',1)", [existing, available])).rejects.toMatchObject({ code: '42501' });
    await expect(pools.runtime.query("CREATE FUNCTION ledger.bypass() RETURNS integer LANGUAGE SQL AS 'SELECT 1' ")).rejects.toMatchObject({ code: '42501' });
    const journal = (entries: unknown) => read((tx) => tx.query('SELECT * FROM ledger.post_journal($1::jsonb,$2::jsonb)', [JSON.stringify({ kind: 'PAY', business_key: randomUUID(), actor_type: 'system', payer_agent_id: payer.id, represented_agent_id: payer.id, spend_points: '1', business_date: '2026-11-07', reason: 'invalid fixture' }), JSON.stringify(entries)]));
    await expect(journal([{ account_id: available, side: 'credit', amount: '2' }, { account_id: recovery, side: 'debit', amount: '1' }])).rejects.toBeDefined();
    await expect(journal([{ account_id: available, side: 'credit', amount: '0' }, { account_id: recovery, side: 'debit', amount: '0' }])).rejects.toBeDefined();
    await expect(journal([{ account_id: control, side: 'credit', amount: '1' }, { account_id: recovery, side: 'debit', amount: '1' }])).rejects.toBeDefined();
    await expect(journal([{ account_id: available, side: 'credit', amount: '101' }, { account_id: recovery, side: 'debit', amount: '101' }])).rejects.toBeDefined();
    expect(await wallet()).toMatchObject({ available: '100', reserved: '0' });
    expect((await read((tx) => reconcile(tx))).ok).toBe(true);
  });

  it('T12 round trips bigint beyond JavaScript safe integer precision without loss', async () => {
    const amount = '9007199254740993';
    await fund(pools.runtime, admin, payer.id, amount);
    const result = await wallet();
    expect(result.available).toBe(amount);
    expect(JSON.parse(JSON.stringify(result)).available).toBe(amount);
    const report = await read((tx) => reconcile(tx));
    expect(report.ok).toBe(true); expect(report.totals.issued).toBe(amount); expect(report.totals.circulating).toBe(amount);
  });

  it('same request key with changed parameters conflicts and leaves the first result intact', async () => {
    await fund(pools.runtime, admin, payer.id, '100');
    const key = randomUUID(); const input = reserveInput('40');
    await command(pools.runtime, owner, payer.id, 'test/reserve', input, (tx, ctx) => reserve(tx, ctx, input), key);
    await expect(command(pools.runtime, owner, payer.id, 'test/reserve', { ...input, amount: '41' }, (tx, ctx) => reserve(tx, ctx, { ...input, amount: '41' }), key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await wallet()).toMatchObject({ available: '60', reserved: '40' });
  });

  it('quarantines a reported account inconsistency and never repairs historical balances automatically', async () => {
    await fund(pools.runtime, admin, payer.id, '100');
    await pools.migration.query("UPDATE public.ledger_accounts SET balance=99 WHERE agent_id=$1 AND bucket='AVAILABLE'", [payer.id]);
    const report = await read((tx) => reconcile(tx));
    expect(report.ok).toBe(false); expect(report.differences.some((difference) => difference.type === 'ACCOUNT_BALANCE')).toBe(true);
    expect(await wallet()).toMatchObject({ available: '99' });
    await expect(reserveFor('1')).rejects.toMatchObject({ code: 'LEDGER_QUARANTINED' });
    expect((await pools.runtime.query('SELECT count(*)::text AS count FROM public.credit_holds WHERE payer_agent_id=$1', [payer.id])).rows[0].count).toBe('0');
  });
});
