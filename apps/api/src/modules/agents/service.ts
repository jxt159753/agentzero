import { randomUUID } from 'node:crypto';
import type { Actor } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError, audit, type CommandResult } from '../../core.js';

export async function createAgent(tx: Tx, actor: Extract<Actor, { type: 'user' }>, name: string, requestId: string, limit = 5) {
  // Both creation routes already hold this owner's row lock, so concurrent requests share the quota.
  const existing = (await tx.query('SELECT count(*)::int AS count FROM agents WHERE owner_user_id=$1 AND deleted_at IS NULL', [actor.userId])).rows[0].count as number;
  if (existing >= limit) throw new AppError('AGENT_LIMIT_EXCEEDED', 409, `每位用户最多保留 ${limit} 个 Agent，请先处理不再使用的 Agent`);
  const agent = (await tx.query('INSERT INTO agents(id,owner_user_id,name) VALUES($1,$2,$3) RETURNING *', [randomUUID(), actor.userId, name.trim()])).rows[0];
  await tx.query('INSERT INTO agent_policies(agent_id) VALUES($1)', [agent.id]);
  await tx.query('SELECT ledger.open_agent_accounts($1)', [agent.id]);
  await audit(tx, { ...actor, representedAgentId: agent.id }, 'agent.created', 'agent', agent.id, requestId, { name: agent.name });
  return agent;
}

/** The caller holds the owner and Agent locks, shared by all business commands. */
export async function deleteAgent(tx: Tx, actor: Extract<Actor, { type: 'user' }>, id: string, version: string, requestId: string): Promise<CommandResult> {
  const agent = (await tx.query('SELECT id,version,deleted_at FROM agents WHERE id=$1', [id])).rows[0];
  const result = (row: { version: string; deleted_at: Date }) => ({ status: 200, body: { id, deleted: true, version: row.version, deleted_at: row.deleted_at.toISOString() }, resourceType: 'agent', resourceId: id });
  if (agent.deleted_at) return result(agent);
  if (agent.version !== version) throw new AppError('AGENT_VERSION_CONFLICT', 409, 'Agent 已被修改，请刷新后重新确认删除');

  const blocked = (await tx.query(`SELECT
    EXISTS(SELECT 1 FROM ledger_accounts WHERE agent_id=$1 AND balance<>0) AS balance,
    EXISTS(SELECT 1 FROM credit_holds WHERE payer_agent_id=$1 AND status='open') AS holds,
    EXISTS(SELECT 1 FROM land_plots WHERE owner_agent_id=$1) AS lands,
    EXISTS(SELECT 1 FROM item_instances WHERE owner_agent_id=$1) AS items,
    EXISTS(SELECT 1 FROM market_listings WHERE seller_agent_id=$1 AND status='active') AS listings,
    EXISTS(SELECT 1 FROM tasks WHERE status NOT IN ('settled','cancelled')
      AND $1 IN (publisher_agent_id,payer_agent_id,assignee_agent_id)) AS tasks,
    EXISTS(SELECT 1 FROM agreement_members am JOIN collaboration_agreements ca ON ca.id=am.agreement_id
      JOIN tasks t ON t.id=ca.task_id WHERE am.agent_id=$1 AND ca.status IN ('pending','active')
        AND t.status NOT IN ('settled','cancelled')) AS collaborations,
    EXISTS(SELECT 1 FROM reward_redemptions WHERE agent_id=$1 AND status IN ('pending','processing')) AS rewards`, [id])).rows[0];
  const reasons = [
    blocked.balance && '钱包仍有可用或冻结积分',
    blocked.holds && '仍有未关闭的资金冻结',
    blocked.lands && '仍管理主人的土地，请先完成转让',
    blocked.items && '仍持有物品，请先完成转让',
    blocked.listings && '仍有有效挂牌，请先撤销或完成交易',
    blocked.tasks && '仍有未完成的任务或任务草稿',
    blocked.collaborations && '仍参与待确认或进行中的协作协议',
    blocked.rewards && '仍有待领取或处理中的奖励兑换',
  ].filter(Boolean);
  if (reasons.length) throw new AppError('AGENT_DELETE_BLOCKED', 409, `暂时无法删除：${reasons.join('；')}。处理完成后可重新删除。`);

  const deleted = (await tx.query("UPDATE agents SET status='paused',deleted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING version,deleted_at", [id])).rows[0];
  await tx.query('UPDATE agent_keys SET revoked_at=clock_timestamp() WHERE agent_id=$1 AND revoked_at IS NULL', [id]);
  await tx.query("UPDATE world_positions SET expires_at=clock_timestamp(),updated_at=clock_timestamp() WHERE kind='agent' AND agent_id=$1", [id]);
  await tx.query('DELETE FROM world_publications WHERE agent_id=$1', [id]);
  await tx.query('UPDATE contribution_reward_preferences SET agent_id=NULL,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND agent_id=$2', [actor.userId, id]);
  await audit(tx, { ...actor, representedAgentId: id }, 'agent.deleted', 'agent', id, requestId, { version: deleted.version });
  return result(deleted);
}
