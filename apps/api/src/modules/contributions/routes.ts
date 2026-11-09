import type { FastifyInstance } from 'fastify';
import { withTransaction } from '@agentzero/database';
import {
  ClaimContributionReward, PageQuery, UpdateContributionPreference, UpdateContributionRewards, parseAmount,
  type ClaimContributionRewardInput, type UpdateContributionPreferenceInput, type UpdateContributionRewardsInput,
} from '@agentzero/contracts';
import { AppError, audit, decodeCursor, lockActor, paginated } from '../../core.js';
import { command, replayCommand, requireUser, type ApiContext } from '../../http.js';
import type { GitHubRepositoryProvider } from '../github/provider.js';
import { assertRepositoryAvailable } from '../github/service.js';
import { contributionSettings, parseContributionUrl, payContribution } from './service.js';

export async function registerContributions(app: FastifyInstance, ctx: ApiContext, provider: GitHubRepositoryProvider) {
  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/api/v1/contributions', { schema: { querystring: PageQuery } }, async request => {
    const actor = requireUser(request);
    return withTransaction(ctx.pool, async tx => {
      await lockActor(tx, actor);
      const cursor = decodeCursor(request.query.cursor), limit = Number(request.query.limit ?? 30);
      const preference = (await tx.query('SELECT agent_id,version,updated_at FROM contribution_reward_preferences WHERE user_id=$1', [actor.userId])).rows[0]
        ?? { agent_id: null, version: '0', updated_at: null };
      const rows = (await tx.query(`SELECT * FROM contribution_rewards WHERE user_id=$1
        AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,
      [actor.userId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1])).rows;
      return { settings: await contributionSettings(tx), preference, ...paginated(rows, limit) };
    });
  });

  app.put<{ Body: UpdateContributionPreferenceInput }>('/api/v1/contributions/preference', { schema: { body: UpdateContributionPreference } }, async (request, reply) => {
    const actor = requireUser(request), body = request.body;
    return command(ctx, request, reply, { ...(body.agent_id ? { agentId: body.agent_id } : {}) }, async tx => {
      const prior = (await tx.query('SELECT version FROM contribution_reward_preferences WHERE user_id=$1 FOR UPDATE', [actor.userId])).rows[0];
      if ((prior?.version ?? '0') !== body.version) throw new AppError('CONTRIBUTION_VERSION_CONFLICT', 409, '自动收款设置已变化，请刷新后重试');
      const preference = (await tx.query(`INSERT INTO contribution_reward_preferences(user_id,agent_id) VALUES($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET agent_id=excluded.agent_id,version=contribution_reward_preferences.version+1,updated_at=clock_timestamp()
        RETURNING agent_id,version,updated_at`, [actor.userId, body.agent_id])).rows[0]!;
      await audit(tx, actor, 'contribution.preference_updated', 'user', actor.userId, request.id, { agent_id: body.agent_id });
      return { status: 200, body: preference };
    });
  });

  app.get('/api/v1/admin/contribution-rewards', async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { admin: true });
    return contributionSettings(tx);
  }));
  app.put<{ Body: UpdateContributionRewardsInput }>('/api/v1/admin/contribution-rewards', { schema: { body: UpdateContributionRewards } }, async (request, reply) => {
    const actor = requireUser(request), body = request.body;
    return command(ctx, request, reply, { admin: true }, async tx => {
      for (const value of [body.commit_points, body.pull_request_points, body.issue_points]) parseAmount(value);
      const row = (await tx.query(`UPDATE contribution_reward_settings SET commit_points=$1,pull_request_points=$2,issue_points=$3,
        version=version+1,updated_at=clock_timestamp() WHERE id=1 AND version=$4
        RETURNING commit_points,pull_request_points,issue_points,version,updated_at`,
      [body.commit_points, body.pull_request_points, body.issue_points, body.version])).rows[0];
      if (!row) throw new AppError('CONTRIBUTION_VERSION_CONFLICT', 409, '提交奖励配置已变化，请刷新后重试');
      await audit(tx, actor, 'contribution.settings_updated', 'contribution_settings', '1', request.id,
        { commit_points: body.commit_points, pull_request_points: body.pull_request_points, issue_points: body.issue_points, reason: body.reason });
      return { status: 200, body: row };
    });
  });

  app.post<{ Body: ClaimContributionRewardInput }>('/api/v1/contributions/claim', { schema: { body: ClaimContributionReward } }, async (request, reply) => {
    const actor = requireUser(request), body = request.body;
    if (await replayCommand(ctx, request, reply, { agentId: body.agent_id })) return reply;
    const target = parseContributionUrl(body.url);
    const repository = await withTransaction(ctx.pool, async tx => {
      await lockActor(tx, actor, { agentId: body.agent_id });
      const row = (await tx.query('SELECT id FROM repositories WHERE lower(owner)=lower($1) AND lower(name)=lower($2)', [target.owner, target.name])).rows[0];
      if (!row) throw new AppError('REPOSITORY_UNAVAILABLE', 409, '该仓库尚未准入，请联系管理员');
      return assertRepositoryAvailable(tx, row.id);
    });
    if (!provider.getContribution) throw new AppError('GITHUB_NOT_CONFIGURED', 503);
    const evidence = await provider.getContribution({ installationId: repository.installation_id, repositoryId: repository.github_id,
      owner: repository.owner, name: repository.name, kind: target.kind, objectId: target.objectId });
    if (evidence.kind !== target.kind || evidence.objectId !== target.objectId || evidence.repositoryId !== repository.github_id) {
      throw new AppError('CONTRIBUTION_BINDING_MISMATCH', 409, 'GitHub 返回的提交与领取链接不一致');
    }
    return command(ctx, request, reply, { agentId: body.agent_id }, async tx => {
      const current = await assertRepositoryAvailable(tx, repository.id);
      if (current.installation_id !== repository.installation_id || current.github_id !== repository.github_id || current.owner !== repository.owner || current.name !== repository.name) {
        throw new AppError('REPOSITORY_UNAVAILABLE', 409, '仓库配置已变化，请重新领取');
      }
      const reward = await payContribution(tx, { actor, requestId: request.id, userId: actor.userId, agentId: body.agent_id,
        repositoryId: repository.id, evidence, settingsVersion: body.version });
      return { status: 200, body: { ...reward }, resourceType: 'contribution_reward', resourceId: reward.id };
    });
  });
}
