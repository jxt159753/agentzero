import { randomUUID } from 'node:crypto';
import type { Actor, ContributionKindValue, ContributionRewardDto, ContributionRewardSettingsDto } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError, audit } from '../../core.js';
import type { GitHubContributionEvidence } from '../github/provider.js';
import { assertRepositoryAvailable } from '../github/service.js';
import { finalizeHold, reserve } from '../ledger/service.js';

export function parseContributionUrl(value: string): { owner: string; name: string; kind: ContributionKindValue; objectId: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('INVALID_CONTRIBUTION_URL', 400, '请填写完整的 GitHub commit、PR 或 Issue 链接'); }
  const match = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/(commit|pull|issues)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || !match) {
    throw new AppError('INVALID_CONTRIBUTION_URL', 400, '仅支持 github.com 上的 commit、PR 或 Issue 链接');
  }
  const kind = ({ commit: 'commit', pull: 'pull_request', issues: 'issue' } as const)[match[3] as 'commit' | 'pull' | 'issues'];
  const objectId = match[4]!;
  if (!(kind === 'commit' ? /^[0-9a-f]{40}$/.test(objectId) : /^[1-9][0-9]{0,14}$/.test(objectId))) {
    throw new AppError('INVALID_CONTRIBUTION_URL', 400, 'commit 链接须包含完整的 40 位 SHA；PR 和 Issue 须包含有效编号');
  }
  return { owner: match[1]!, name: match[2]!, kind, objectId };
}

export async function contributionSettings(tx: Tx, lock = false): Promise<ContributionRewardSettingsDto> {
  return (await tx.query<ContributionRewardSettingsDto>(`SELECT commit_points,pull_request_points,issue_points,version,updated_at
    FROM contribution_reward_settings WHERE id=1${lock ? ' FOR SHARE' : ''}`)).rows[0]!;
}

// Claims, webhooks and history all use the contribution itself to identify one reward.
export async function payContribution(tx: Tx, input: {
  actor: Actor; requestId: string; userId: string; agentId: string; repositoryId: string;
  evidence: GitHubContributionEvidence; settingsVersion?: string;
}): Promise<ContributionRewardDto> {
  const user = (await tx.query('SELECT github_user_id,status FROM users WHERE id=$1 FOR UPDATE', [input.userId])).rows[0];
  if (!user || user.status !== 'active') throw new AppError('ACCOUNT_SUSPENDED', 403);
  const agent = (await tx.query('SELECT owner_user_id,status,deleted_at FROM agents WHERE id=$1 FOR UPDATE', [input.agentId])).rows[0];
  if (!agent || agent.owner_user_id !== input.userId) throw new AppError('ACCESS_DENIED', 403);
  if (agent.deleted_at) throw new AppError('AGENT_DELETED', 410);
  if (agent.status !== 'active') throw new AppError('AGENT_PAUSED', 403);
  const evidence = input.evidence;
  if (!evidence.authorGithubId || evidence.authorGithubId !== user.github_user_id) {
    throw new AppError('CONTRIBUTION_IDENTITY_MISMATCH', 409, '该提交的 GitHub 作者与当前账号不一致，或尚未关联 GitHub 账号');
  }
  const repository = await assertRepositoryAvailable(tx, input.repositoryId);
  if (repository.github_id !== evidence.repositoryId) throw new AppError('CONTRIBUTION_BINDING_MISMATCH', 409);
  const businessKey = `contribution:${input.repositoryId}:${evidence.kind}:${evidence.objectId}`;
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [businessKey]);
  const prior = (await tx.query<ContributionRewardDto>('SELECT * FROM contribution_rewards WHERE repository_id=$1 AND kind=$2 AND object_id=$3',
    [input.repositoryId, evidence.kind, evidence.objectId])).rows[0];
  if (prior) {
    if (prior.user_id !== input.userId) throw new AppError('CONTRIBUTION_IDENTITY_MISMATCH', 409);
    return prior;
  }
  const settings = await contributionSettings(tx, true);
  if (input.settingsVersion !== undefined && settings.version !== input.settingsVersion) {
    throw new AppError('CONTRIBUTION_VERSION_CONFLICT', 409, '提交奖励金额已变化，请刷新后领取');
  }
  const amount = settings[`${evidence.kind}_points`];
  if (amount === '0') throw new AppError('CONTRIBUTION_DISABLED', 409, '当前尚未开启这类提交奖励');
  const reason = `GitHub ${evidence.kind} 提交奖励：${repository.full_name} ${evidence.objectId}`;
  const ledgerContext = { actor: { type: 'system' } as const, requestId: input.requestId };
  const hold = await reserve(tx, ledgerContext, { businessRef: businessKey, payerAgentId: null, amount, permission: 'can_accept_task', reason });
  const payment = await finalizeHold(tx, ledgerContext, { holdId: String(hold.holdId), payments: [{ agentId: input.agentId, amount }], refund: '0', reason });
  const reward = (await tx.query<ContributionRewardDto>(`INSERT INTO contribution_rewards
    (id,repository_id,kind,object_id,user_id,agent_id,points,settings_version,url,title,github_created_at,transaction_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
  [randomUUID(), input.repositoryId, evidence.kind, evidence.objectId, input.userId, input.agentId, amount, settings.version,
    evidence.url, evidence.title, evidence.createdAt, payment.transactionId])).rows[0]!;
  await audit(tx, input.actor, 'contribution.rewarded', 'contribution_reward', reward.id, input.requestId,
    { user_id: input.userId, agent_id: input.agentId, points: amount, repository_id: input.repositoryId, kind: evidence.kind, object_id: evidence.objectId }, businessKey);
  return reward;
}
