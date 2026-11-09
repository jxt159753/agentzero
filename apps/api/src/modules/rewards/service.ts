import { randomBytes, randomUUID } from 'node:crypto';
import type {
  Actor, CreateRewardOfferInput, CreateRewardRedemptionInput, FulfillRewardInput, PatchRewardOfferInput, PutRewardPoolInput,
  RewardActionInput, RewardCatalogDto, RewardOfferDto, RewardPoolDto, RewardRedemptionDto, RewardRedemptionQueryInput,
} from '@agentzero/contracts';
import { parseAmount } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError, audit, decodeCursor, paginated } from '../../core.js';
import { pay, refund } from '../ledger/service.js';

type PoolRow = RewardPoolDto;
type OfferRow = Omit<RewardOfferDto, 'remaining_quantity' | 'created_at'> & { created_at: Date | string };
export type RedemptionRow = Omit<RewardRedemptionDto, 'created_at' | 'updated_at' | 'fulfilled_at' | 'cancelled_at'> & {
  created_at: Date | string; updated_at: Date | string; fulfilled_at: Date | string | null; cancelled_at: Date | string | null;
};

const poolFields = 'id,month::text,total_quantity::text,allocated_quantity::text,user_monthly_limit::text,contact_qq,instructions,status,version::text';
const redemptionSelect = `SELECT r.*,u.github_login,a.name AS agent_name FROM reward_redemptions r
  JOIN users u ON u.id=r.user_id JOIN agents a ON a.id=r.agent_id`;

export function rewardUserId(actor: Actor): string {
  if (actor.type === 'system') throw new AppError('ACCESS_DENIED', 403);
  return actor.type === 'user' ? actor.userId : actor.ownerUserId;
}
function adminUserId(actor: Actor): string {
  if (actor.type !== 'user') throw new AppError('ACCESS_DENIED', 403);
  return actor.userId;
}
export async function rewardMonth(tx: Tx): Promise<string> {
  return (await tx.query<{ month: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-01') AS month")).rows[0]!.month;
}
function requireVersion(current: string, expected: string) {
  parseAmount(expected);
  if (current !== expected) throw new AppError('REWARD_VERSION_CONFLICT', 409, '奖励记录已变化，请刷新后重试');
}
function requireState(row: RedemptionRow, statuses: RedemptionRow['status'][]) {
  if (!statuses.includes(row.status)) throw new AppError('REWARD_STATE_CONFLICT', 409, '当前领取状态不允许此操作');
}
function poolBody(row: PoolRow): RewardPoolDto {
  return { id: row.id, month: row.month, total_quantity: row.total_quantity, allocated_quantity: row.allocated_quantity,
    user_monthly_limit: row.user_monthly_limit, contact_qq: row.contact_qq, instructions: row.instructions, status: row.status, version: row.version };
}
function offerBody(row: OfferRow): RewardOfferDto {
  return { id: row.id, pool_id: row.pool_id, title: row.title, description: row.description, points_cost: row.points_cost,
    total_quantity: row.total_quantity, redeemed_quantity: row.redeemed_quantity,
    remaining_quantity: (BigInt(row.total_quantity) - BigInt(row.redeemed_quantity)).toString(),
    status: row.status, version: row.version, created_at: new Date(row.created_at).toISOString() };
}
export function redemptionBody(row: RedemptionRow): RewardRedemptionDto {
  return { ...row, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
    fulfilled_at: row.fulfilled_at ? new Date(row.fulfilled_at).toISOString() : null,
    cancelled_at: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null };
}
async function lockPool(tx: Tx, id: string): Promise<PoolRow> {
  const pool = (await tx.query<PoolRow>(`SELECT ${poolFields} FROM reward_pools WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!pool) throw new AppError('NOT_FOUND', 404, '奖励池不存在');
  return pool;
}
async function lockOffer(tx: Tx, id: string): Promise<OfferRow> {
  const offer = (await tx.query<OfferRow>('SELECT * FROM reward_offers WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!offer) throw new AppError('NOT_FOUND', 404, '奖励报价不存在');
  return offer;
}
async function offerPoolId(tx: Tx, id: string): Promise<string> {
  const row = (await tx.query<{ pool_id: string }>('SELECT pool_id FROM reward_offers WHERE id=$1', [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, '奖励报价不存在');
  return row.pool_id;
}
async function lockAgentPolicy(tx: Tx, agentId: string) {
  const row = (await tx.query('SELECT agent_id FROM agent_policies WHERE agent_id=$1 FOR UPDATE', [agentId])).rows[0];
  if (!row) throw new AppError('ACCESS_DENIED', 403);
}
async function redeemedCount(tx: Tx, userId: string, poolId: string): Promise<string> {
  // Cancelled redemptions remain in the monthly allowance. There is no refundable quota cache.
  return (await tx.query<{ count: string }>('SELECT count(*)::text AS count FROM reward_redemptions WHERE user_id=$1 AND pool_id=$2', [userId, poolId])).rows[0]!.count;
}

export async function rewardCatalog(tx: Tx, actor: Actor, month?: string): Promise<RewardCatalogDto> {
  const pool = (await tx.query<PoolRow>(`SELECT ${poolFields} FROM reward_pools WHERE month=$1::date FOR SHARE`, [month ?? await rewardMonth(tx)])).rows[0];
  if (!pool) return { pool: null, offers: [], redeemed_count: '0', remaining_count: '0' };
  const offers = (await tx.query<OfferRow>('SELECT * FROM reward_offers WHERE pool_id=$1 ORDER BY created_at,id', [pool.id])).rows;
  const count = await redeemedCount(tx, rewardUserId(actor), pool.id);
  const remaining = BigInt(pool.user_monthly_limit) - BigInt(count);
  return { pool: poolBody(pool), offers: offers.map(offerBody), redeemed_count: count, remaining_count: (remaining > 0n ? remaining : 0n).toString() };
}

export async function putRewardPool(tx: Tx, actor: Actor, requestId: string, month: string, input: PutRewardPoolInput) {
  const userId = adminUserId(actor), total = parseAmount(input.total_quantity), limit = parseAmount(input.user_monthly_limit);
  parseAmount(input.version);
  if (limit > total) throw new AppError('REWARD_POOL_LIMIT', 409, '用户月度上限不能超过奖励池总份数');
  let pool: PoolRow;
  if (input.version === '0') {
    const row = (await tx.query<PoolRow>(`INSERT INTO reward_pools(month,total_quantity,user_monthly_limit,contact_qq,instructions,status,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(month) DO NOTHING RETURNING ${poolFields}`,
    [month, input.total_quantity, input.user_monthly_limit, input.contact_qq, input.instructions.trim(), input.status, userId])).rows[0];
    if (!row) throw new AppError('REWARD_VERSION_CONFLICT', 409, '此月份已配置，请刷新后编辑');
    pool = row;
  } else {
    const current = (await tx.query<PoolRow>(`SELECT ${poolFields} FROM reward_pools WHERE month=$1::date FOR UPDATE`, [month])).rows[0];
    if (!current) throw new AppError('REWARD_VERSION_CONFLICT', 409, '此月份尚未配置，请刷新后创建');
    requireVersion(current.version, input.version);
    if (total < BigInt(current.allocated_quantity)) throw new AppError('REWARD_POOL_LIMIT', 409, '奖励池总份数不能低于已分配报价的份数');
    pool = (await tx.query<PoolRow>(`UPDATE reward_pools SET total_quantity=$2,user_monthly_limit=$3,contact_qq=$4,instructions=$5,status=$6,
      version=version+1,updated_by=$7,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${poolFields}`,
    [current.id, input.total_quantity, input.user_monthly_limit, input.contact_qq, input.instructions.trim(), input.status, userId])).rows[0]!;
  }
  await audit(tx, actor, 'rewards.pool_updated', 'reward_pool', pool.id, requestId, { ...input, month, version: pool.version });
  return { status: input.version === '0' ? 201 : 200, body: { ...poolBody(pool) }, resourceType: 'reward_pool', resourceId: pool.id };
}

export async function createRewardOffer(tx: Tx, actor: Actor, requestId: string, input: CreateRewardOfferInput) {
  const userId = adminUserId(actor), quantity = parseAmount(input.total_quantity);
  parseAmount(input.points_cost, true);
  const pool = await lockPool(tx, input.pool_id);
  if (BigInt(pool.allocated_quantity) + quantity > BigInt(pool.total_quantity)) throw new AppError('REWARD_POOL_LIMIT', 409, '报价库存超过奖励池可分配份数');
  const offer = (await tx.query<OfferRow>(`INSERT INTO reward_offers(pool_id,title,description,points_cost,total_quantity,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [pool.id, input.title.trim(), input.description.trim(), input.points_cost, input.total_quantity, userId])).rows[0]!;
  await tx.query('UPDATE reward_pools SET allocated_quantity=allocated_quantity+$2::bigint,version=version+1,updated_by=$3,updated_at=clock_timestamp() WHERE id=$1', [pool.id, input.total_quantity, userId]);
  await audit(tx, actor, 'rewards.offer_created', 'reward_offer', offer.id, requestId, { ...input });
  return { status: 201, body: { ...offerBody(offer) }, resourceType: 'reward_offer', resourceId: offer.id };
}

export async function patchRewardOffer(tx: Tx, actor: Actor, requestId: string, id: string, input: PatchRewardOfferInput) {
  const userId = adminUserId(actor), added = parseAmount(input.add_quantity);
  const pool = await lockPool(tx, await offerPoolId(tx, id)), offer = await lockOffer(tx, id);
  requireVersion(offer.version, input.version);
  if (BigInt(pool.allocated_quantity) + added > BigInt(pool.total_quantity)) throw new AppError('REWARD_POOL_LIMIT', 409, '新增库存超过奖励池可分配份数');
  const updated = (await tx.query<OfferRow>(`UPDATE reward_offers SET total_quantity=total_quantity+$2::bigint,status=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id, input.add_quantity, input.status])).rows[0]!;
  if (added > 0n) await tx.query('UPDATE reward_pools SET allocated_quantity=allocated_quantity+$2::bigint,version=version+1,updated_by=$3,updated_at=clock_timestamp() WHERE id=$1', [pool.id, input.add_quantity, userId]);
  await audit(tx, actor, 'rewards.offer_updated', 'reward_offer', id, requestId, { ...input, version: updated.version });
  return { status: 200, body: { ...offerBody(updated) }, resourceType: 'reward_offer', resourceId: id };
}

export async function loadRewardRedemption(tx: Tx, id: string, actor: Actor, admin = false, lock = false): Promise<RedemptionRow> {
  const row = (await tx.query<RedemptionRow>(`${redemptionSelect} WHERE r.id=$1 AND ($2 OR (r.user_id=$3 AND ($4::uuid IS NULL OR r.agent_id=$4)))${lock ? ' FOR UPDATE OF r' : ''}`,
    [id, admin, rewardUserId(actor), actor.type === 'agent' ? actor.agentId : null])).rows[0];
  if (!row) throw new AppError('ACCESS_DENIED', 403, '无权访问此领取凭证');
  return row;
}
export async function rewardRedemptionPage(tx: Tx, actor: Actor, query: RewardRedemptionQueryInput, admin = false) {
  const cursor = decodeCursor(query.cursor), limit = Number(query.limit ?? 30);
  const rows = (await tx.query<RedemptionRow>(`${redemptionSelect} WHERE ($1 OR (r.user_id=$2 AND ($3::uuid IS NULL OR r.agent_id=$3)))
    AND ($4::text IS NULL OR r.status=$4) AND ($5::text IS NULL OR r.claim_code=$5)
    AND ($6::timestamptz IS NULL OR (r.created_at,r.id)<($6,$7::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT $8`,
  [admin, rewardUserId(actor), actor.type === 'agent' ? actor.agentId : null, query.status ?? null, query.claim_code ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1])).rows;
  const page = paginated(rows, limit);
  return { ...page, items: page.items.map(row => redemptionBody(row as RedemptionRow)) };
}
async function redemptionResult(tx: Tx, id: string, actor: Actor, status = 200, admin = false) {
  const row = await loadRewardRedemption(tx, id, actor, admin);
  return { status, body: { ...redemptionBody(row) }, resourceType: 'reward_redemption', resourceId: id };
}

export async function createRewardRedemption(tx: Tx, actor: Actor, requestId: string, input: CreateRewardRedemptionInput) {
  const userId = rewardUserId(actor);
  // runCommand already holds the owning user/Agent/credential. All reward writes use
  // user -> Agent policy -> pool -> offer -> redemption -> ledger account locks.
  await lockAgentPolicy(tx, input.agent_id);
  const pool = await lockPool(tx, await offerPoolId(tx, input.offer_id)), offer = await lockOffer(tx, input.offer_id);
  if (pool.month !== await rewardMonth(tx)) throw new AppError('REWARD_MONTH_CLOSED', 409, '此月份已停止新增兑换，已领取凭证继续有效');
  if (pool.status !== 'active' || offer.status !== 'active') throw new AppError('REWARD_UNAVAILABLE', 409, '此奖励当前暂停兑换');
  if (BigInt(offer.redeemed_quantity) >= BigInt(offer.total_quantity)) throw new AppError('REWARD_SOLD_OUT', 409, '此奖励已兑完');
  const count = await redeemedCount(tx, userId, pool.id);
  if (BigInt(count) >= BigInt(pool.user_monthly_limit)) throw new AppError('REWARD_MONTHLY_LIMIT', 409, '已达到用户本月兑换上限，取消不恢复限额');
  const id = randomUUID(), claimCode = `RWD-${randomBytes(16).toString('hex').toUpperCase()}`;
  const payment = await pay(tx, { actor, requestId }, { businessKey: `reward:${id}:pay`, payerAgentId: input.agent_id,
    amount: offer.points_cost, permission: 'can_redeem_api', reason: `兑换奖励：${offer.title}` });
  // The account lock in pay can wait across midnight. Roll the entire exchange back
  // if its month closed while waiting, including the point payment.
  if (pool.month !== await rewardMonth(tx)) throw new AppError('REWARD_MONTH_CLOSED', 409, '此月份已停止新增兑换，已领取凭证继续有效');
  await tx.query(`INSERT INTO reward_redemptions(id,claim_code,user_id,agent_id,pool_id,offer_id,title,description,points_cost,contact_qq,instructions,claimant_qq,payment_transaction_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [id, claimCode, userId, input.agent_id, pool.id, offer.id, offer.title, offer.description, offer.points_cost, pool.contact_qq, pool.instructions, input.claimant_qq, payment.transactionId]);
  await tx.query('UPDATE reward_offers SET redeemed_quantity=redeemed_quantity+1,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [offer.id]);
  await audit(tx, actor, 'rewards.redeemed', 'reward_redemption', id, requestId, { offer_id: offer.id, pool_id: pool.id, points_cost: offer.points_cost, payment_transaction_id: payment.transactionId });
  return redemptionResult(tx, id, actor, 201);
}

export async function changeRewardRedemption(tx: Tx, actor: Actor, requestId: string, prior: RedemptionRow, action: 'process' | 'fulfill' | 'cancel', input: RewardActionInput | FulfillRewardInput, admin: boolean) {
  await lockAgentPolicy(tx, prior.agent_id);
  await lockPool(tx, prior.pool_id);
  await lockOffer(tx, prior.offer_id);
  const row = await loadRewardRedemption(tx, prior.id, actor, admin, true);
  requireVersion(row.version, input.version);
  if (admin && row.status === 'processing' && action !== 'process' && row.processed_by !== adminUserId(actor)) {
    throw new AppError('REWARD_PROCESSOR_CONFLICT', 409, '此凭证由其他管理员处理，请由开始处理的管理员确认发放或退款');
  }
  if (action === 'process') {
    if (!admin) throw new AppError('ACCESS_DENIED', 403);
    requireState(row, ['pending']);
    await tx.query(`UPDATE reward_redemptions SET status='processing',processed_by=$2,admin_note=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1`, [row.id, adminUserId(actor), input.reason.trim()]);
  } else if (action === 'fulfill') {
    if (!admin || !('fulfillment_reference' in input)) throw new AppError('ACCESS_DENIED', 403);
    requireState(row, ['processing']);
    await tx.query(`UPDATE reward_redemptions SET status='fulfilled',processed_by=$2,fulfillment_reference=$3,admin_note=$4,fulfilled_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
      [row.id, adminUserId(actor), input.fulfillment_reference.trim(), input.reason.trim()]);
  } else {
    requireState(row, admin ? ['pending', 'processing'] : ['pending']);
    // Existing obligations can be refunded even if the Agent was paused or its key revoked.
    // The caller's authorization is recorded below; the ledger authorizes owner refunds as system fulfillment.
    const repayment = await refund(tx, { actor: admin ? actor : { type: 'system' }, requestId }, {
      businessKey: `reward:${row.id}:refund`, originalTransactionId: row.payment_transaction_id, amount: row.points_cost, reason: `取消奖励兑换：${input.reason.trim()}`,
    });
    await tx.query('UPDATE reward_offers SET redeemed_quantity=redeemed_quantity-1,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [row.offer_id]);
    await tx.query(`UPDATE reward_redemptions SET status='cancelled',refund_transaction_id=$2,processed_by=$3,admin_note=$4,cancelled_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
      [row.id, repayment.transactionId, admin ? adminUserId(actor) : row.processed_by, input.reason.trim()]);
  }
  await audit(tx, actor, `rewards.${action === 'cancel' ? 'cancelled' : action === 'process' ? 'processing' : 'fulfilled'}`, 'reward_redemption', row.id, requestId, { ...input, previous_status: row.status });
  return redemptionResult(tx, row.id, actor, 200, admin);
}
