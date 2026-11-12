import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTransaction } from '@agentzero/database';
import {
  BuyMarketAsset, CancelMarketListing, CreateItemTemplate, CreateLandSupply, CreateMarketListing, IdParams,
  PatchItemTemplate, PatchLandPrice, PatchStudio, PlaceMarketItem, PutMarketSettings, AdminAssetAction, AdminAssetTransfer, AdminItemModeration, AdminLandModeration, WorldModelParams,
  type AdminAssetActionInput, type AdminAssetTransferInput, type AdminItemModerationInput, type AdminLandModerationInput,
  type BuyMarketAssetInput, type CancelMarketListingInput, type CreateItemTemplateInput, type CreateLandSupplyInput,
  type CreateMarketListingInput, type PatchItemTemplateInput, type PatchLandPriceInput, type PatchStudioInput, type PlaceMarketItemInput, type PutMarketSettingsInput,
} from '@agentzero/contracts';
import { lockActor } from '../../core.js';
import { command, type ApiContext } from '../../http.js';
import {
  buyLand, buyListing, buyTemplate, cancelListing, createItemTemplate, createLandSupply, createListing,
  listingOwner, loadLand, loadListing, marketAssets, marketCatalog, patchItemTemplate, patchLandPrice, patchStudio, placeItem, putMarketSettings, readItem,
  adminAssetCatalog, adminCancelListing, assetOwnerIds, assetTransferOwners, moderateItem, moderateLand, returnAdminItem, transferAdminAsset,
} from './service.js';
import { adminDeleteWorldModel } from '../world/models.js';

function represent(request: FastifyRequest, agentId: string) {
  if (request.actor.type === 'user') request.actor = { ...request.actor, representedAgentId: agentId };
}

export async function registerMarket(app: FastifyInstance, ctx: ApiContext) {
  const owners = (request: FastifyRequest, kind: 'lands' | 'items', id: string) => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { admin: true });
    return assetOwnerIds(tx, kind, id);
  });
  app.get('/api/v1/admin/assets', request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { admin: true });
    return adminAssetCatalog(tx);
  }));
  for (const kind of ['lands', 'items'] as const) {
    app.post<{ Params: { id: string }; Body: AdminAssetTransferInput }>(`/api/v1/admin/assets/${kind}/:id/transfer`,
      { schema: { params: IdParams, body: AdminAssetTransfer } }, async (request, reply) => {
        const userIds = await withTransaction(ctx.pool, async tx => {
          await lockActor(tx, request.actor, { admin: true });
          return assetTransferOwners(tx, request.body.expected_owner_agent_id, request.body.target_agent_id);
        });
        return command(ctx, request, reply, { admin: true, userIds }, tx => transferAdminAsset(tx, request.actor, request.id, kind, request.params.id, request.body));
      });
  }
  app.patch<{ Params: { id: string }; Body: AdminLandModerationInput }>('/api/v1/admin/assets/lands/:id',
    { schema: { params: IdParams, body: AdminLandModeration } }, async (request, reply) => {
      const userIds = await owners(request, 'lands', request.params.id);
      return command(ctx, request, reply, { admin: true, userIds }, tx => moderateLand(tx, request.actor, request.id, request.params.id, request.body));
    });
  app.patch<{ Params: { id: string }; Body: AdminItemModerationInput }>('/api/v1/admin/assets/items/:id',
    { schema: { params: IdParams, body: AdminItemModeration } }, async (request, reply) => {
      const userIds = await owners(request, 'items', request.params.id);
      return command(ctx, request, reply, { admin: true, userIds }, tx => moderateItem(tx, request.actor, request.id, request.params.id, request.body));
    });
  app.post<{ Params: { id: string }; Body: AdminAssetActionInput }>('/api/v1/admin/assets/listings/:id/cancel',
    { schema: { params: IdParams, body: AdminAssetAction } }, async (request, reply) => {
      const seller = await withTransaction(ctx.pool, async tx => {
        await lockActor(tx, request.actor, { admin: true }); return listingOwner(tx, request.params.id);
      });
      return command(ctx, request, reply, { admin: true, userIds: [seller.seller_user_id] }, tx => adminCancelListing(tx, request.actor, request.id, request.params.id, request.body));
    });
  app.post<{ Params: { id: string }; Body: AdminAssetActionInput }>('/api/v1/admin/assets/items/:id/return',
    { schema: { params: IdParams, body: AdminAssetAction } }, async (request, reply) => {
      const userIds = await owners(request, 'items', request.params.id);
      return command(ctx, request, reply, { admin: true, userIds }, tx => returnAdminItem(tx, request.actor, request.id, request.params.id, request.body));
    });
  app.delete<{ Params: { id: string; placementId: string }; Body: AdminAssetActionInput }>('/api/v1/admin/assets/lands/:id/models/:placementId',
    { schema: { params: WorldModelParams, body: AdminAssetAction } }, async (request, reply) => {
      const userIds = await owners(request, 'lands', request.params.id);
      return command(ctx, request, reply, { admin: true, userIds }, tx => adminDeleteWorldModel(tx, request.actor, request.id, request.params.id, request.params.placementId, request.body));
    });
  for (const [path, admin] of [['/api/v1/market', false], ['/api/v1/admin/market', true]] as const) {
    app.get(path, async request => withTransaction(ctx.pool, async tx => {
      await lockActor(tx, request.actor, { allowPaused: true, admin });
      return marketCatalog(tx, request.actor, admin);
    }));
  }
  app.get<{ Params: { id: string } }>('/api/v1/agents/:id/assets', { schema: { params: IdParams } }, async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { agentId: request.params.id, allowPaused: true });
    return marketAssets(tx, request.actor, request.params.id);
  }));
  app.get<{ Params: { id: string } }>('/api/v1/market/lands/:id', { schema: { params: IdParams } }, async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true });
    return loadLand(tx, request.params.id);
  }));
  app.get<{ Params: { id: string } }>('/api/v1/market/items/:id', { schema: { params: IdParams } }, async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true });
    return readItem(tx, request.params.id, request.actor);
  }));
  app.get<{ Params: { id: string } }>('/api/v1/market/listings/:id', { schema: { params: IdParams } }, async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true });
    return loadListing(tx, request.params.id);
  }));

  app.put<{ Body: PutMarketSettingsInput }>('/api/v1/admin/market/settings', { schema: { body: PutMarketSettings } }, async (request, reply) =>
    command(ctx, request, reply, { admin: true }, tx => putMarketSettings(tx, request.actor, request.id, request.body)));
  app.post<{ Body: CreateLandSupplyInput }>('/api/v1/admin/market/lands', { schema: { body: CreateLandSupply } }, async (request, reply) =>
    command(ctx, request, reply, { admin: true }, tx => createLandSupply(tx, request.actor, request.id, request.body)));
  app.patch<{ Params: { id: string }; Body: PatchLandPriceInput }>('/api/v1/admin/market/lands/:id', { schema: { params: IdParams, body: PatchLandPrice } }, async (request, reply) =>
    command(ctx, request, reply, { admin: true }, tx => patchLandPrice(tx, request.actor, request.id, request.params.id, request.body)));
  app.post<{ Body: CreateItemTemplateInput }>('/api/v1/admin/market/templates', { schema: { body: CreateItemTemplate } }, async (request, reply) =>
    command(ctx, request, reply, { admin: true }, tx => createItemTemplate(tx, request.actor, request.id, request.body)));
  app.patch<{ Params: { id: string }; Body: PatchItemTemplateInput }>('/api/v1/admin/market/templates/:id', { schema: { params: IdParams, body: PatchItemTemplate } }, async (request, reply) =>
    command(ctx, request, reply, { admin: true }, tx => patchItemTemplate(tx, request.actor, request.id, request.params.id, request.body)));

  for (const kind of ['lands', 'templates', 'listings'] as const) {
    app.post<{ Params: { id: string }; Body: BuyMarketAssetInput }>(`/api/v1/market/${kind}/:id/buy`, { schema: { params: IdParams, body: BuyMarketAsset } }, async (request, reply) => {
      // A listing's seller is immutable. Fetch that owner before command() takes all user locks in sorted order.
      const seller = kind === 'listings' ? await withTransaction(ctx.pool, tx => listingOwner(tx, request.params.id)) : null;
      represent(request, request.body.agent_id);
      const action = kind === 'lands' ? buyLand : kind === 'templates' ? buyTemplate : buyListing;
      return command(ctx, request, reply, { agentId: request.body.agent_id, userIds: seller ? [seller.seller_user_id] : [] },
        tx => action(tx, request.actor, request.id, request.params.id, request.body));
    });
  }
  app.post<{ Body: CreateMarketListingInput }>('/api/v1/market/listings', { schema: { body: CreateMarketListing } }, async (request, reply) => {
    represent(request, request.body.agent_id);
    return command(ctx, request, reply, { agentId: request.body.agent_id }, tx => createListing(tx, request.actor, request.id, request.body));
  });
  app.post<{ Params: { id: string }; Body: CancelMarketListingInput }>('/api/v1/market/listings/:id/cancel', { schema: { params: IdParams, body: CancelMarketListing } }, async (request, reply) => {
    const seller = await withTransaction(ctx.pool, tx => listingOwner(tx, request.params.id));
    represent(request, seller.seller_agent_id);
    return command(ctx, request, reply, { agentId: seller.seller_agent_id, allowPaused: true }, tx => cancelListing(tx, request.actor, request.id, request.params.id, request.body));
  });
  app.patch<{ Params: { id: string }; Body: PatchStudioInput }>('/api/v1/market/lands/:id/studio', { schema: { params: IdParams, body: PatchStudio } }, async (request, reply) => {
    represent(request, request.body.agent_id);
    return command(ctx, request, reply, { agentId: request.body.agent_id }, tx => patchStudio(tx, request.actor, request.id, request.params.id, request.body));
  });
  app.post<{ Params: { id: string }; Body: PlaceMarketItemInput }>('/api/v1/market/items/:id/place', { schema: { params: IdParams, body: PlaceMarketItem } }, async (request, reply) => {
    represent(request, request.body.agent_id);
    return command(ctx, request, reply, { agentId: request.body.agent_id }, tx => placeItem(tx, request.actor, request.id, request.params.id, request.body));
  });
}
