import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTransaction } from '@agentzero/database';
import {
  CreateRewardOffer, CreateRewardRedemption, FulfillReward, IdParams, PatchRewardOffer, PutRewardPool,
  RewardAction, RewardCatalogQuery, RewardMonthParams, RewardRedemptionQuery,
  type CreateRewardOfferInput, type CreateRewardRedemptionInput, type FulfillRewardInput, type PatchRewardOfferInput,
  type PutRewardPoolInput, type RewardActionInput, type RewardRedemptionQueryInput,
} from '@agentzero/contracts';
import { lockActor } from '../../core.js';
import { command, type ApiContext } from '../../http.js';
import {
  changeRewardRedemption, createRewardOffer, createRewardRedemption, loadRewardRedemption, patchRewardOffer,
  putRewardPool, redemptionBody, rewardCatalog, rewardRedemptionPage,
} from './service.js';

type RedemptionRequest = FastifyRequest<{ Params: { id: string } }>;
async function snapshot(ctx: ApiContext, request: RedemptionRequest, admin = false) {
  return withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true, admin });
    return loadRewardRedemption(tx, request.params.id, request.actor, admin);
  });
}

export async function registerRewards(app: FastifyInstance, ctx: ApiContext) {
  app.get<{ Querystring: { month?: string } }>('/api/v1/rewards', { schema: { querystring: RewardCatalogQuery } }, async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true });
    return rewardCatalog(tx, request.actor, request.query.month);
  }));
  app.get<{ Params: { month: string } }>('/api/v1/admin/reward-pools/:month', { schema: { params: RewardMonthParams } }, async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { admin: true });
    return rewardCatalog(tx, request.actor, request.params.month);
  }));
  app.put<{ Params: { month: string }; Body: PutRewardPoolInput }>('/api/v1/admin/reward-pools/:month', { schema: { params: RewardMonthParams, body: PutRewardPool } }, async (request, reply) =>
    command(ctx, request, reply, { admin: true }, tx => putRewardPool(tx, request.actor, request.id, request.params.month, request.body)));
  app.post<{ Body: CreateRewardOfferInput }>('/api/v1/admin/reward-offers', { schema: { body: CreateRewardOffer } }, async (request, reply) =>
    command(ctx, request, reply, { admin: true }, tx => createRewardOffer(tx, request.actor, request.id, request.body)));
  app.patch<{ Params: { id: string }; Body: PatchRewardOfferInput }>('/api/v1/admin/reward-offers/:id', { schema: { params: IdParams, body: PatchRewardOffer } }, async (request, reply) =>
    command(ctx, request, reply, { admin: true }, tx => patchRewardOffer(tx, request.actor, request.id, request.params.id, request.body)));

  app.post<{ Body: CreateRewardRedemptionInput }>('/api/v1/reward-redemptions', { schema: { body: CreateRewardRedemption } }, async (request, reply) => {
    const agentId = request.body.agent_id;
    if (request.actor.type === 'user') request.actor = { ...request.actor, representedAgentId: agentId };
    return command(ctx, request, reply, { agentId }, tx => createRewardRedemption(tx, request.actor, request.id, request.body));
  });
  app.get<{ Querystring: RewardRedemptionQueryInput }>('/api/v1/reward-redemptions', { schema: { querystring: RewardRedemptionQuery } }, async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true });
    return rewardRedemptionPage(tx, request.actor, request.query);
  }));
  app.get<{ Params: { id: string } }>('/api/v1/reward-redemptions/:id', { schema: { params: IdParams } }, async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true });
    return redemptionBody(await loadRewardRedemption(tx, request.params.id, request.actor));
  }));
  app.post<{ Params: { id: string }; Body: RewardActionInput }>('/api/v1/reward-redemptions/:id/cancel', { schema: { params: IdParams, body: RewardAction } }, async (request, reply) => {
    const prior = await snapshot(ctx, request);
    if (request.actor.type === 'user') request.actor = { ...request.actor, representedAgentId: prior.agent_id };
    return command(ctx, request, reply, { agentId: prior.agent_id, allowPaused: true }, tx => changeRewardRedemption(tx, request.actor, request.id, prior, 'cancel', request.body, false));
  });
  app.get<{ Querystring: RewardRedemptionQueryInput }>('/api/v1/admin/reward-redemptions', { schema: { querystring: RewardRedemptionQuery } }, async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { admin: true });
    return rewardRedemptionPage(tx, request.actor, request.query, true);
  }));
  for (const action of ['process', 'fulfill', 'cancel'] as const) {
    app.post<{ Params: { id: string }; Body: RewardActionInput | FulfillRewardInput }>(`/api/v1/admin/reward-redemptions/:id/${action}`, { schema: { params: IdParams, body: action === 'fulfill' ? FulfillReward : RewardAction } }, async (request, reply) => {
      const prior = await snapshot(ctx, request, true);
      // Lock both administrator and owner in the global sorted user order before touching the order.
      return command(ctx, request, reply, { admin: true, userIds: [prior.user_id] }, tx => changeRewardRedemption(tx, request.actor, request.id, prior, action, request.body, true));
    });
  }
}
