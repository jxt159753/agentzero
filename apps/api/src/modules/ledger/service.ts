import { randomUUID } from 'node:crypto';
import type { Actor, WalletReferenceInput } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError, audit, hash } from '../../core.js';

export type LedgerContext = { actor: Actor; requestId: string };
export type Permission = 'can_accept_task' | 'can_collaborate' | 'can_trade' | 'can_redeem_api';
type Entry = { account_id: string; side: 'debit' | 'credit'; amount: string };
type Result = Record<string, unknown> & { transactionId: string; businessKey: string; created: boolean };
type Policy = Record<Permission, boolean> & { single_spend_limit: string; daily_spend_limit: string };
type Hold = {
  id: string; business_ref: string; payer_agent_id: string | null; payer_user_id: string | null;
  source_account_id: string; reserved_account_id: string; reserved_total: string;
  captured_total: string; released_total: string; status: 'open' | 'closed'; version: string;
};
type Payment = { amount: string } & ({ agentId: string; userId?: never } | { userId: string; agentId?: never });
const MAX_POINTS = 9_223_372_036_854_775_807n;
const PERMISSIONS: readonly string[] = ['can_accept_task', 'can_collaborate', 'can_trade', 'can_redeem_api'];

function points(value: string, positive = false): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new AppError('INVALID_AMOUNT');
  const amount = BigInt(value);
  if (amount > MAX_POINTS || (positive && amount === 0n)) throw new AppError('INVALID_AMOUNT');
  return amount;
}

function validateReason(reason: string): void {
  if (!reason.trim() || reason.length > 1000) throw new AppError('INVALID_INPUT');
}

function validateKey(key: string): void {
  if (!key.trim() || key.length > 240) throw new AppError('INVALID_INPUT');
}

function actorColumns(actor: Actor, representedAgentId?: string | null) {
  return {
    actor_type: actor.type,
    actor_user_id: actor.type === 'user' ? actor.userId : null,
    actor_agent_id: actor.type === 'agent' ? actor.agentId : null,
    credential_id: actor.type === 'agent' ? actor.credentialId : null,
    represented_agent_id: representedAgentId ?? (actor.type === 'agent' ? actor.agentId : actor.type === 'user' ? actor.representedAgentId ?? null : null),
  };
}

async function currentDate(tx: Tx): Promise<string> {
  const result = await tx.query<{ date: string }>("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::text AS date");
  return result.rows[0]!.date;
}

async function requireAdmin(tx: Tx, actor: Actor): Promise<void> {
  if (actor.type !== 'user') throw new AppError('ACCESS_DENIED', 403);
  const user = await tx.query('SELECT role,status FROM public.users WHERE id=$1', [actor.userId]);
  if (user.rows[0]?.role !== 'admin' || user.rows[0]?.status !== 'active') throw new AppError('ACCESS_DENIED', 403);
}

async function lockPolicy(tx: Tx, agentId: string | null): Promise<Policy | null> {
  if (!agentId) return null;
  const policy = await tx.query<Policy>('SELECT * FROM public.agent_policies WHERE agent_id=$1 FOR UPDATE', [agentId]);
  if (!policy.rows[0]) throw new AppError('ACCESS_DENIED', 403);
  return policy.rows[0];
}

async function requirePayer(tx: Tx, actor: Actor, payerAgentId: string | null, existing = false, payerUserId?: string | null): Promise<void> {
  if (payerUserId) {
    if (payerAgentId) throw new AppError('INVALID_INPUT');
    if (actor.type === 'system' && existing) return;
    if (actor.type !== 'user' || actor.userId !== payerUserId) throw new AppError('ACCESS_DENIED', 403);
    if (!existing && (await tx.query('SELECT status FROM public.users WHERE id=$1', [payerUserId])).rows[0]?.status !== 'active') {
      throw new AppError('ACCESS_DENIED', 403);
    }
    return;
  }
  if (actor.type === 'system') {
    if (existing || payerAgentId === null) return;
    throw new AppError('ACCESS_DENIED', 403);
  }
  if (payerAgentId === null) return requireAdmin(tx, actor);
  const result = await tx.query('SELECT a.owner_user_id,a.status,u.status AS user_status FROM public.agents a JOIN public.users u ON u.id=a.owner_user_id WHERE a.id=$1', [payerAgentId]);
  const agent = result.rows[0];
  if (!agent || (actor.type === 'agent' ? actor.agentId !== payerAgentId : actor.userId !== agent.owner_user_id)) throw new AppError('ACCESS_DENIED', 403);
  if (!existing) {
    if (agent.user_status !== 'active') throw new AppError('ACCESS_DENIED', 403);
    if (agent.status !== 'active') throw new AppError('AGENT_PAUSED', 403);
  }
}

async function accounts(tx: Tx, agentId: string | null, userId?: string | null): Promise<{ available: string; reserved: string }> {
  const rows = (await tx.query<{ id: string; bucket: string }>(
    userId ? 'SELECT id,bucket FROM public.ledger_accounts WHERE user_id=$1' : agentId ? 'SELECT id,bucket FROM public.ledger_accounts WHERE agent_id=$1' : "SELECT id,bucket FROM public.ledger_accounts WHERE system_key IN ('REWARD_POOL','REWARD_RESERVED')",
    userId ? [userId] : agentId ? [agentId] : [],
  )).rows;
  const available = rows.find((row) => row.bucket === (userId ? 'USER_AVAILABLE' : agentId ? 'AVAILABLE' : 'REWARD_POOL'))?.id;
  const reserved = rows.find((row) => row.bucket === (userId ? 'USER_RESERVED' : agentId ? 'RESERVED' : 'REWARD_RESERVED'))?.id;
  if (!available || !reserved) throw new AppError('LEDGER_INCONSISTENT', 409);
  return { available, reserved };
}

async function systemAccount(tx: Tx, key: string): Promise<string> {
  const result = await tx.query<{ id: string }>('SELECT id FROM public.ledger_accounts WHERE system_key=$1', [key]);
  if (!result.rows[0]) throw new AppError('LEDGER_INCONSISTENT', 409);
  return result.rows[0].id;
}

async function replay(tx: Tx, key: string, command: unknown): Promise<Result | null> {
  const result = await tx.query<{ id: string; details: { commandHash?: string; result?: Result } | null }>(
    `SELECT j.id,a.details FROM public.journal_transactions j
     LEFT JOIN public.audit_events a ON a.target_type='journal' AND a.target_id=j.id::text AND a.action='ledger.posted'
     WHERE j.business_key=$1`, [key],
  );
  if (!result.rows[0]) return null;
  const recorded = result.rows[0];
  if (!recorded.details?.result || !recorded.details.commandHash) throw new AppError('LEDGER_INCONSISTENT', 409);
  if (recorded.details.commandHash !== hash(command).toString('hex')) throw new AppError('BUSINESS_CONFLICT', 409);
  return { ...recorded.details.result, created: false };
}

async function post(tx: Tx, ctx: LedgerContext, data: {
  kind: string; key: string; command: unknown; date: string; reason: string;
  payerAgentId?: string | null; spend?: bigint; correctionOf?: string; entries: Entry[];
}, resultFields: Record<string, unknown>): Promise<Result> {
  const blocked = await tx.query(
    `SELECT 1 FROM public.audit_events WHERE action='ledger.quarantined'
     AND (target_type='ledger' OR (target_type='account' AND target_id=ANY($1::text[]))) LIMIT 1`,
    [data.entries.map((entry) => entry.account_id)],
  );
  if (blocked.rowCount) throw new AppError('LEDGER_QUARANTINED', 409);
  const header = {
    kind: data.kind, business_key: data.key, ...actorColumns(ctx.actor, data.payerAgentId),
    payer_agent_id: data.payerAgentId ?? null, spend_points: (data.spend ?? 0n).toString(),
    business_date: data.date, correction_of: data.correctionOf ?? null, reason: data.reason,
  };
  const journal = (await tx.query<{ transaction_id: string; created: boolean }>(
    'SELECT * FROM ledger.post_journal($1::jsonb,$2::jsonb)', [JSON.stringify(header), JSON.stringify(data.entries)],
  )).rows[0]!;
  if (!journal.created) {
    const previous = await replay(tx, data.key, data.command);
    if (!previous) throw new AppError('LEDGER_INCONSISTENT', 409);
    return previous;
  }
  const result: Result = { ...resultFields, transactionId: journal.transaction_id, businessKey: data.key, created: true };
  const auditActor = ctx.actor.type === 'user' && data.payerAgentId ? { ...ctx.actor, representedAgentId: data.payerAgentId } : ctx.actor;
  await audit(tx, auditActor, 'ledger.posted', 'journal', journal.transaction_id, ctx.requestId,
    { commandHash: hash(data.command).toString('hex'), result }, data.key);
  return result;
}

async function budgetUsage(tx: Tx, agentId: string, date: string) {
  const result = await tx.query<{ spent: string; held: string }>(
    `SELECT COALESCE((SELECT sum(spend_points) FROM public.journal_transactions WHERE payer_agent_id=$1 AND business_date=$2::date),0)::text AS spent,
      COALESCE((SELECT sum(reserved_total-captured_total-released_total) FROM public.credit_holds WHERE payer_agent_id=$1 AND status='open'),0)::text AS held`,
    [agentId, date],
  );
  const row = result.rows[0]!;
  return { spent: BigInt(row.spent), held: BigInt(row.held) };
}

async function checkCommitment(tx: Tx, agentId: string | null, policy: Policy | null, permission: Permission, date: string, commitment: bigint, increase: bigint) {
  if (!PERMISSIONS.includes(permission)) throw new AppError('INVALID_INPUT');
  if (!agentId) return;
  if (!policy?.[permission]) throw new AppError('ACCESS_DENIED', 403);
  const usage = await budgetUsage(tx, agentId, date);
  if (commitment > BigInt(policy.single_spend_limit) || usage.spent + usage.held + increase > BigInt(policy.daily_spend_limit)) {
    throw new AppError('SPEND_LIMIT_EXCEEDED', 409);
  }
}

export async function setIssuanceLimit(tx: Tx, ctx: LedgerContext, input: { month: string; limitPoints: string; reason: string }) {
  await requireAdmin(tx, ctx.actor);
  validateReason(input.reason);
  const limit = points(input.limitPoints);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new AppError('INVALID_INPUT');
  const period = `${input.month}-01`;
  await tx.query('INSERT INTO public.credit_issuance_periods(period,limit_points,issued_points,updated_by) VALUES($1,0,0,$2) ON CONFLICT DO NOTHING', [period, ctx.actor.type === 'user' ? ctx.actor.userId : null]);
  const row = (await tx.query<{ issued_points: string }>('SELECT issued_points FROM public.credit_issuance_periods WHERE period=$1 FOR UPDATE', [period])).rows[0]!;
  if (limit < BigInt(row.issued_points)) throw new AppError('ISSUANCE_LIMIT_EXCEEDED', 409);
  await tx.query('UPDATE public.credit_issuance_periods SET limit_points=$2,updated_by=$3,updated_at=clock_timestamp() WHERE period=$1', [period, input.limitPoints, ctx.actor.type === 'user' ? ctx.actor.userId : null]);
  await audit(tx, ctx.actor, 'issuance.limit_changed', 'issuance_period', period, ctx.requestId, { limitPoints: input.limitPoints, issuedPoints: row.issued_points, reason: input.reason });
  return { period, limitPoints: input.limitPoints, issuedPoints: row.issued_points };
}

export async function issue(tx: Tx, ctx: LedgerContext, input: { businessKey: string; amount: string; reason: string; month?: string }): Promise<Result> {
  await requireAdmin(tx, ctx.actor);
  validateKey(input.businessKey); validateReason(input.reason);
  const amount = points(input.amount, true);
  const command = { kind: 'ISSUE', ...input };
  const previous = await replay(tx, input.businessKey, command);
  if (previous) return previous;
  // Re-read the business date after taking the budget lock: a request may wait across midnight.
  let date = await currentDate(tx);
  const period = `${date.slice(0, 7)}-01`;
  const budget = (await tx.query<{ limit_points: string; issued_points: string }>('SELECT limit_points,issued_points FROM public.credit_issuance_periods WHERE period=$1 FOR UPDATE', [period])).rows[0];
  date = await currentDate(tx);
  const repeated = await replay(tx, input.businessKey, command);
  if (repeated) return repeated;
  if (date.slice(0, 7) !== period.slice(0, 7)) throw new AppError('ISSUANCE_PERIOD_CHANGED', 409);
  if (input.month && input.month !== date.slice(0, 7)) throw new AppError('INVALID_ISSUANCE_PERIOD', 409);
  if (!budget || BigInt(budget.issued_points) + amount > BigInt(budget.limit_points)) throw new AppError('ISSUANCE_LIMIT_EXCEEDED', 409);
  const result = await post(tx, ctx, {
    kind: 'ISSUE', key: input.businessKey, command, date, reason: input.reason,
    entries: [
      { account_id: await systemAccount(tx, 'REWARD_POOL'), side: 'debit', amount: input.amount },
      { account_id: await systemAccount(tx, 'ISSUANCE_CONTROL'), side: 'credit', amount: input.amount },
    ],
  }, { amount: input.amount, period });
  if (result.created) await tx.query('UPDATE public.credit_issuance_periods SET issued_points=issued_points+$2::bigint,updated_at=clock_timestamp() WHERE period=$1', [period, input.amount]);
  return result;
}

export async function reserve(tx: Tx, ctx: LedgerContext, input: { businessRef: string; payerAgentId: string | null; payerUserId?: string; amount: string; permission: Permission; reason: string }): Promise<Result> {
  validateKey(input.businessRef); validateReason(input.reason);
  const amount = points(input.amount, true);
  await requirePayer(tx, ctx.actor, input.payerAgentId, false, input.payerUserId);
  const policy = await lockPolicy(tx, input.payerAgentId);
  const key = `hold:${input.businessRef}:reserve`;
  const command = { kind: 'RESERVE', ...input };
  const previous = await replay(tx, key, command);
  if (previous) return previous;
  const pair = await accounts(tx, input.payerAgentId, input.payerUserId);
  // The unique business_ref is also the serialization point for platform holds, which have no policy row.
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO public.credit_holds(id,business_ref,payer_agent_id,source_account_id,reserved_account_id,reserved_total,captured_total,released_total,status,version,payer_user_id)
     VALUES($1,$2,$3,$4,$5,$6,0,0,'open',1,$7) ON CONFLICT(business_ref) DO NOTHING RETURNING id`,
    [randomUUID(), input.businessRef, input.payerAgentId, pair.available, pair.reserved, input.amount, input.payerUserId ?? null],
  );
  const hold = (await tx.query<Hold>('SELECT * FROM public.credit_holds WHERE business_ref=$1 FOR UPDATE', [input.businessRef])).rows[0]!;
  if (!inserted.rowCount) {
    const existing = await replay(tx, key, command);
    if (existing) return existing;
    throw new AppError('LEDGER_INCONSISTENT', 409);
  }
  const date = await currentDate(tx);
  // The just-inserted hold already contributes to daily usage; increase=0 prevents counting it twice.
  await checkCommitment(tx, input.payerAgentId, policy, input.permission, date, amount, 0n);
  return post(tx, ctx, {
    kind: 'RESERVE', key, command, date, reason: input.reason, payerAgentId: input.payerAgentId,
    entries: [{ account_id: pair.reserved, side: 'debit', amount: input.amount }, { account_id: pair.available, side: 'credit', amount: input.amount }],
  }, { holdId: hold.id, remaining: input.amount, status: 'open', version: '1' });
}

async function loadHold(tx: Tx, holdId: string, lock = false): Promise<Hold> {
  const hold = (await tx.query<Hold>(`SELECT * FROM public.credit_holds WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [holdId])).rows[0];
  if (!hold) throw new AppError('NOT_FOUND', 404);
  return hold;
}

function remaining(hold: Hold) { return BigInt(hold.reserved_total) - BigInt(hold.captured_total) - BigInt(hold.released_total); }

export async function adjustHold(tx: Tx, ctx: LedgerContext, input: { holdId: string; amount: string; revision: string; permission: Permission; reason: string }): Promise<Result> {
  validateKey(input.revision); validateReason(input.reason);
  // Closing the final commitment is a finalize operation, so an editable hold stays positive.
  const target = points(input.amount, true);
  let hold = await loadHold(tx, input.holdId);
  await requirePayer(tx, ctx.actor, hold.payer_agent_id, true, hold.payer_user_id);
  const policy = await lockPolicy(tx, hold.payer_agent_id);
  hold = await loadHold(tx, input.holdId, true);
  const key = `hold:${input.holdId}:adjust:${input.revision}`;
  const command = { kind: 'ADJUST_HOLD', ...input };
  const previous = await replay(tx, key, command);
  if (previous) return previous;
  if (hold.status !== 'open') throw new AppError('BUSINESS_ALREADY_FINALIZED', 409);
  const delta = target - remaining(hold);
  if (delta === 0n) throw new AppError('NO_CHANGE', 409);
  const date = await currentDate(tx);
  if (delta > 0n) {
    await requirePayer(tx, ctx.actor, hold.payer_agent_id, false, hold.payer_user_id);
    await checkCommitment(tx, hold.payer_agent_id, policy, input.permission, date, target, delta);
  }
  const amount = (delta < 0n ? -delta : delta).toString();
  const result = await post(tx, ctx, {
    kind: 'ADJUST_HOLD', key, command, date, reason: input.reason, payerAgentId: hold.payer_agent_id,
    entries: [
      { account_id: hold.reserved_account_id, side: delta > 0n ? 'debit' : 'credit', amount },
      { account_id: hold.source_account_id, side: delta > 0n ? 'credit' : 'debit', amount },
    ],
  }, { holdId: hold.id, remaining: input.amount, status: 'open', version: (BigInt(hold.version) + 1n).toString() });
  if (result.created) await tx.query(
    `UPDATE public.credit_holds SET reserved_total=reserved_total+$2::bigint,released_total=released_total+$3::bigint,version=version+1 WHERE id=$1`,
    [hold.id, delta > 0n ? amount : '0', delta < 0n ? amount : '0'],
  );
  return result;
}

export async function finalizeHold(tx: Tx, ctx: LedgerContext, input: { holdId: string; payments: Payment[]; refund: string; reason: string }): Promise<Result> {
  return settleHold(tx, ctx, input);
}

/** Domain-authorized partial settlement of an existing escrow; never exposed as an arbitrary transfer route. */
export async function captureHold(tx: Tx, ctx: LedgerContext, input: { holdId: string; payments: Payment[]; refund: string; reason: string; businessKey: string }): Promise<Result> {
  validateKey(input.businessKey);
  return settleHold(tx, ctx, input, input.businessKey);
}

async function settleHold(tx: Tx, ctx: LedgerContext, input: { holdId: string; payments: Payment[]; refund: string; reason: string }, partialKey?: string): Promise<Result> {
  validateReason(input.reason);
  const refund = points(input.refund);
  const recipient = (payment: Payment) => payment.agentId ? `agent:${payment.agentId}` : `user:${payment.userId}`;
  const payments = input.payments.map((payment) => ({ ...payment, value: points(payment.amount, true) })).sort((a, b) => recipient(a).localeCompare(recipient(b)));
  if (new Set(payments.map(recipient)).size !== payments.length) throw new AppError('INVALID_INPUT');
  let hold = await loadHold(tx, input.holdId);
  await requirePayer(tx, ctx.actor, hold.payer_agent_id, true, hold.payer_user_id);
  await lockPolicy(tx, hold.payer_agent_id);
  hold = await loadHold(tx, input.holdId, true);
  const key = partialKey ?? `hold:${input.holdId}:finalize`;
  const command = { kind: 'FINALIZE_HOLD', ...input, payments: payments.map(({ agentId, userId, amount }) => agentId ? { agentId, amount } : { userId, amount }) };
  const previous = await replay(tx, key, command);
  if (previous) return previous;
  if (hold.status !== 'open') throw new AppError('BUSINESS_ALREADY_FINALIZED', 409);
  const captured = payments.reduce((sum, payment) => sum + payment.value, 0n);
  const total = remaining(hold);
  const consumed = captured + refund, rest = total - consumed;
  if (consumed <= 0n || rest < 0n || (!partialKey && rest !== 0n)) throw new AppError('INVALID_SETTLEMENT');
  if (payments.some((payment) => payment.agentId ? payment.agentId === hold.payer_agent_id : payment.userId === hold.payer_user_id)) throw new AppError('INVALID_SETTLEMENT');
  const entries: Entry[] = [{ account_id: hold.reserved_account_id, side: 'credit', amount: consumed.toString() }];
  for (const payment of payments) entries.push({ account_id: (await accounts(tx, payment.agentId ?? null, payment.userId)).available, side: 'debit', amount: payment.amount });
  if (refund > 0n) entries.push({ account_id: hold.source_account_id, side: 'debit', amount: input.refund });
  const result = await post(tx, ctx, {
    kind: 'FINALIZE_HOLD', key, command, date: await currentDate(tx), reason: input.reason,
    payerAgentId: hold.payer_agent_id, spend: hold.payer_agent_id ? captured : 0n, entries,
  }, { holdId: hold.id, paid: captured.toString(), refunded: input.refund, remaining: rest.toString(), status: rest === 0n ? 'closed' : 'open', version: (BigInt(hold.version) + 1n).toString() });
  if (result.created) await tx.query(
    "UPDATE public.credit_holds SET captured_total=captured_total+$2::bigint,released_total=released_total+$3::bigint,status=$4,version=version+1,closed_at=CASE WHEN $4='closed' THEN clock_timestamp() ELSE NULL END WHERE id=$1",
    [hold.id, captured.toString(), input.refund, rest === 0n ? 'closed' : 'open'],
  );
  return result;
}

export async function pay(tx: Tx, ctx: LedgerContext, input: { businessKey: string; payerAgentId: string; amount: string; permission: Permission; reason: string }): Promise<Result> {
  validateKey(input.businessKey); validateReason(input.reason);
  const amount = points(input.amount, true);
  await requirePayer(tx, ctx.actor, input.payerAgentId);
  const policy = await lockPolicy(tx, input.payerAgentId);
  const command = { kind: 'PAY', ...input };
  const previous = await replay(tx, input.businessKey, command);
  if (previous) return previous;
  const date = await currentDate(tx);
  await checkCommitment(tx, input.payerAgentId, policy, input.permission, date, amount, amount);
  return post(tx, ctx, {
    kind: 'PAY', key: input.businessKey, command, date, reason: input.reason, payerAgentId: input.payerAgentId, spend: amount,
    entries: [{ account_id: (await accounts(tx, input.payerAgentId)).available, side: 'credit', amount: input.amount }, { account_id: await systemAccount(tx, 'RECOVERY'), side: 'debit', amount: input.amount }],
  }, { amount: input.amount });
}

/** Domain-authorized compensation; the route must never expose arbitrary refunds. */
export async function refund(tx: Tx, ctx: LedgerContext, input: { businessKey: string; originalTransactionId: string; amount: string; reason: string }): Promise<Result> {
  validateKey(input.businessKey); validateReason(input.reason);
  if (ctx.actor.type !== 'system') await requireAdmin(tx, ctx.actor);
  const amount = points(input.amount, true);
  const original = (await tx.query<{ payer_agent_id: string; spend_points: string; kind: string }>('SELECT payer_agent_id,spend_points,kind FROM public.journal_transactions WHERE id=$1', [input.originalTransactionId])).rows[0];
  if (!original || original.kind !== 'PAY') throw new AppError('INVALID_REFUND');
  await lockPolicy(tx, original.payer_agent_id);
  const command = { kind: 'REFUND', ...input };
  const previous = await replay(tx, input.businessKey, command);
  if (previous) return previous;
  const recoveryId = await systemAccount(tx, 'RECOVERY');
  const refunded = (await tx.query<{ amount: string }>(
    `SELECT COALESCE(sum(e.amount),0)::text AS amount FROM public.journal_transactions j JOIN public.journal_entries e ON e.transaction_id=j.id
     WHERE j.kind='REFUND' AND j.correction_of=$1 AND e.account_id=$2 AND e.side='credit'`, [input.originalTransactionId, recoveryId],
  )).rows[0]!;
  if (BigInt(refunded.amount) + amount > BigInt(original.spend_points)) throw new AppError('INVALID_REFUND');
  return post(tx, ctx, {
    kind: 'REFUND', key: input.businessKey, command, date: await currentDate(tx), reason: input.reason,
    payerAgentId: original.payer_agent_id, correctionOf: input.originalTransactionId,
    entries: [{ account_id: recoveryId, side: 'credit', amount: input.amount }, { account_id: (await accounts(tx, original.payer_agent_id)).available, side: 'debit', amount: input.amount }],
  }, { amount: input.amount, originalTransactionId: input.originalTransactionId });
}

export async function getWallet(tx: Tx, agentId: string) {
  // A single statement keeps balances and budget usage in one READ COMMITTED snapshot.
  const result = await tx.query<{ available: string; reserved: string; today_spent: string; outstanding_held: string; business_date: string }>(
    `WITH day AS (SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date AS value)
     SELECT COALESCE((SELECT balance FROM public.ledger_accounts WHERE agent_id=$1 AND bucket='AVAILABLE'),0)::text AS available,
       COALESCE((SELECT balance FROM public.ledger_accounts WHERE agent_id=$1 AND bucket='RESERVED'),0)::text AS reserved,
       COALESCE((SELECT sum(spend_points) FROM public.journal_transactions WHERE payer_agent_id=$1 AND business_date=day.value),0)::text AS today_spent,
       COALESCE((SELECT sum(reserved_total-captured_total-released_total) FROM public.credit_holds WHERE payer_agent_id=$1 AND status='open'),0)::text AS outstanding_held,
       day.value::text AS business_date FROM day`, [agentId],
  );
  const row = result.rows[0]!;
  return { available: row.available, reserved: row.reserved, todaySpent: row.today_spent, outstandingHeld: row.outstanding_held, dailyUsed: (BigInt(row.today_spent) + BigInt(row.outstanding_held)).toString(), businessDate: row.business_date };
}

/** The caller locks both wallet owners together, before taking any Agent or account locks. */
export async function transfer(tx: Tx, ctx: LedgerContext, input: {
  businessKey: string; from: WalletReferenceInput; to: WalletReferenceInput; amount: string; reason: string;
}): Promise<Result> {
  if (ctx.actor.type !== 'user') throw new AppError('ACCESS_DENIED', 403);
  const actor = ctx.actor;
  validateKey(input.businessKey); validateReason(input.reason);
  const amount = points(input.amount, true);
  if (input.from.type === input.to.type && input.from.id === input.to.id) {
    throw new AppError('SAME_WALLET', 400, '转出和收款钱包不能相同');
  }
  const agentIds = [input.from, input.to].filter(wallet => wallet.type === 'agent').map(wallet => wallet.id);
  const agents = (await tx.query<{ id: string; owner_user_id: string; deleted_at: Date | null }>(
    'SELECT id,owner_user_id,deleted_at FROM public.agents WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [agentIds],
  )).rows;
  const owner = (wallet: WalletReferenceInput) => wallet.type === 'user' ? wallet.id : agents.find(agent => agent.id === wallet.id)?.owner_user_id;
  if (owner(input.from) !== actor.userId) throw new AppError('ACCESS_DENIED', 403, '只能从本人或本人 Agent 的钱包转出');
  const command = { kind: 'TRANSFER', ...input };
  const previous = await replay(tx, input.businessKey, command);
  if (previous) return previous;
  if (agents.some(agent => agent.deleted_at)) throw new AppError('AGENT_DELETED', 410, '已删除的 Agent 不能转账');
  const recipientId = owner(input.to);
  if (!recipientId) throw new AppError('NOT_FOUND', 404, '收款钱包不存在');
  const users = (await tx.query<{ id: string; status: string }>('SELECT id,status FROM public.users WHERE id=ANY($1::uuid[])', [[actor.userId, recipientId]])).rows;
  if (users.find(user => user.id === actor.userId)?.status !== 'active') throw new AppError('ACCESS_DENIED', 403);
  if (users.find(user => user.id === recipientId)?.status !== 'active') throw new AppError('WALLET_UNAVAILABLE', 403, '收款用户尚未激活或已停用');
  const account = async (wallet: WalletReferenceInput) => {
    const row = (await tx.query<{ id: string }>(wallet.type === 'user'
      ? "SELECT id FROM public.ledger_accounts WHERE user_id=$1 AND bucket='USER_AVAILABLE'"
      : "SELECT id FROM public.ledger_accounts WHERE agent_id=$1 AND bucket='AVAILABLE'", [wallet.id])).rows[0];
    if (!row) throw new AppError('LEDGER_INCONSISTENT', 409, '钱包账户尚未建立');
    return row.id;
  };
  // Human owners authorize transfers directly; automatic Agent permissions are unchanged.
  // Outgoing Agent funds still count toward that Agent's daily spending history.
  if (input.from.type === 'agent') await lockPolicy(tx, input.from.id);
  return post(tx, ctx, {
    kind: 'TRANSFER', key: input.businessKey, command, date: await currentDate(tx), reason: input.reason,
    payerAgentId: input.from.type === 'agent' ? input.from.id : null, spend: input.from.type === 'agent' ? amount : 0n,
    entries: [{ account_id: await account(input.from), side: 'credit', amount: input.amount },
      { account_id: await account(input.to), side: 'debit', amount: input.amount }],
  }, { from: input.from, to: input.to, amount: input.amount });
}

type Difference = { type: string; id: string; actual: string; expected: string };

export async function reconcile(tx: Tx, ctx: LedgerContext = { actor: { type: 'system' }, requestId: randomUUID() }) {
  const result = await tx.query<{ differences: Difference[]; totals: Record<string, string> }>(
    `WITH account_sums AS (
       SELECT a.id,a.bucket,a.normal_side,a.balance,COALESCE(sum(CASE WHEN e.side=a.normal_side THEN e.amount::numeric ELSE -e.amount::numeric END),0) AS calculated
       FROM public.ledger_accounts a LEFT JOIN public.journal_entries e ON e.account_id=a.id GROUP BY a.id
     ), held AS (
       SELECT reserved_account_id, sum(reserved_total::numeric-captured_total-released_total) AS total FROM public.credit_holds GROUP BY reserved_account_id
     ), totals AS (
       SELECT COALESCE(sum(balance::numeric) FILTER(WHERE bucket<>'ISSUANCE_CONTROL'),0) AS circulating,
              COALESCE(sum(balance::numeric) FILTER(WHERE bucket='ISSUANCE_CONTROL'),0) AS control,
              (SELECT COALESCE(sum(issued_points::numeric),0) FROM public.credit_issuance_periods)
                + (SELECT COALESCE(sum(e.amount::numeric),0) FROM public.journal_entries e JOIN public.journal_transactions j ON j.id=e.transaction_id
                   WHERE j.kind='INITIAL_GRANT' AND e.side='debit') AS issued FROM public.ledger_accounts
     ), differences AS (
       SELECT 'ACCOUNT_BALANCE' AS type,id::text,balance::text AS actual,calculated::text AS expected FROM account_sums WHERE balance<>calculated
       UNION ALL SELECT 'HOLD_BALANCE',a.id::text,a.balance::text,COALESCE(h.total,0)::text FROM account_sums a LEFT JOIN held h ON h.reserved_account_id=a.id WHERE a.bucket IN ('RESERVED','USER_RESERVED','REWARD_RESERVED') AND a.balance<>COALESCE(h.total,0)
       UNION ALL SELECT 'CONSERVATION','global',circulating::text,control::text FROM totals WHERE circulating<>control
       UNION ALL SELECT 'ISSUANCE_TOTAL','global',issued::text,control::text FROM totals WHERE issued<>control
       UNION ALL SELECT 'UNBALANCED_JOURNAL',j.id::text,COALESCE(sum(e.amount::numeric) FILTER(WHERE side='debit'),0)::text,COALESCE(sum(e.amount::numeric) FILTER(WHERE side='credit'),0)::text
       FROM public.journal_transactions j LEFT JOIN public.journal_entries e ON e.transaction_id=j.id GROUP BY j.id
       HAVING COALESCE(sum(e.amount::numeric) FILTER(WHERE side='debit'),0)<>COALESCE(sum(e.amount::numeric) FILTER(WHERE side='credit'),0) OR count(DISTINCT e.account_id)<2
     )
     SELECT COALESCE((SELECT jsonb_agg(to_jsonb(d)) FROM differences d),'[]'::jsonb) AS differences,
       jsonb_build_object('circulating',circulating::text,'issuanceControl',control::text,'issued',issued::text) AS totals FROM totals`,
  );
  const report = result.rows[0]!;
  for (const difference of report.differences) {
    const account = difference.type === 'ACCOUNT_BALANCE' || difference.type === 'HOLD_BALANCE';
    const targetType = account ? 'account' : 'ledger';
    const targetId = account ? difference.id : 'global';
    const already = await tx.query("SELECT 1 FROM public.audit_events WHERE action='ledger.quarantined' AND target_type=$1 AND target_id=$2 LIMIT 1", [targetType, targetId]);
    if (!already.rowCount) await audit(tx, ctx.actor, 'ledger.quarantined', targetType, targetId, ctx.requestId, difference);
  }
  return { ok: report.differences.length === 0, ...report };
}
