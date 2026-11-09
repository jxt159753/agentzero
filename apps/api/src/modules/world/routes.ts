import type { FastifyInstance } from 'fastify';
import { AddWorldModel, DeleteWorldModel, IdParams, PatchWorldModel, PublishWorldWork, WorldEmpty, WorldModelParams, WorldPresence, WorldWorkParams,
  type AddWorldModelInput, type DeleteWorldModelInput, type PatchWorldModelInput, type PublishWorldWorkInput, type WorldPresenceInput } from '@agentzero/contracts';
import { withTransaction } from '@agentzero/database';
import { AppError, lockActor } from '../../core.js';
import { command, requireUser, type ApiContext } from '../../http.js';
import { heartbeat, leaveWorld, publicationOptions, publishWork, unpublishWork, worldAgentProfile, worldSnapshot, worldStudio } from './service.js';
import { WorldStream } from './stream.js';
import { addWorldModel, deleteWorldModel, patchWorldModel } from './models.js';

export async function registerWorld(app: FastifyInstance, ctx: ApiContext) {
  const stream = new WorldStream(ctx.pool);
  app.addHook('onClose', () => stream.close());
  app.get('/api/v1/world', async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true });
    return worldSnapshot(tx, request.actor);
  }));
  app.get<{ Params: { id: string } }>('/api/v1/world/studios/:id', { schema: { params: IdParams } }, async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true });
    return worldStudio(tx, request.params.id);
  }));
  app.post<{ Params: { id: string }; Body: AddWorldModelInput }>('/api/v1/world/studios/:id/models',
    { schema: { params: IdParams, body: AddWorldModel } }, async (request, reply) => {
      return command(ctx, request, reply, {}, tx => addWorldModel(tx, request.actor, request.id, request.params.id, request.body));
    });
  app.patch<{ Params: { id: string; placementId: string }; Body: PatchWorldModelInput }>('/api/v1/world/studios/:id/models/:placementId',
    { schema: { params: WorldModelParams, body: PatchWorldModel } }, async (request, reply) => {
      return command(ctx, request, reply, {}, tx => patchWorldModel(tx, request.actor, request.id, request.params.id, request.params.placementId, request.body));
    });
  app.delete<{ Params: { id: string; placementId: string }; Body: DeleteWorldModelInput }>('/api/v1/world/studios/:id/models/:placementId',
    { schema: { params: WorldModelParams, body: DeleteWorldModel } }, async (request, reply) => {
      return command(ctx, request, reply, {}, tx => deleteWorldModel(tx, request.actor, request.id, request.params.id, request.params.placementId, request.body));
    });
  app.get<{ Params: { id: string } }>('/api/v1/world/agents/:id', { schema: { params: IdParams } }, async request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true });
    return worldAgentProfile(tx, request.params.id);
  }));
  app.post<{ Body: WorldPresenceInput }>('/api/v1/world/presence', { schema: { body: WorldPresence } }, async (request, reply) =>
    command(ctx, request, reply, {}, tx => heartbeat(tx, request.actor, request.body)));
  app.post('/api/v1/world/leave', { schema: { body: WorldEmpty } }, async (request, reply) =>
    command(ctx, request, reply, { allowPaused: true }, tx => leaveWorld(tx, request.actor)));

  app.get<{ Params: { id: string } }>('/api/v1/world/agents/:id/publication-options', { schema: { params: IdParams } }, async request => {
    const actor = requireUser(request);
    return withTransaction(ctx.pool, async tx => {
      await lockActor(tx, actor, { agentId: request.params.id, allowPaused: true });
      return publicationOptions(tx, request.params.id);
    });
  });
  app.put<{ Params: { id: string; taskId: string }; Body: PublishWorldWorkInput }>('/api/v1/world/agents/:id/works/:taskId',
    { schema: { params: WorldWorkParams, body: PublishWorldWork } }, async (request, reply) => {
      request.actor = { ...requireUser(request), representedAgentId: request.params.id };
      return command(ctx, request, reply, { agentId: request.params.id, allowPaused: true },
        tx => publishWork(tx, request.actor, request.id, request.params.id, request.params.taskId, request.body));
    });
  app.delete<{ Params: { id: string; taskId: string } }>('/api/v1/world/agents/:id/works/:taskId',
    { schema: { params: WorldWorkParams, body: WorldEmpty } }, async (request, reply) => {
      request.actor = { ...requireUser(request), representedAgentId: request.params.id };
      return command(ctx, request, reply, { agentId: request.params.id, allowPaused: true },
        tx => unpublishWork(tx, request.actor, request.id, request.params.id, request.params.taskId));
    });

  app.get('/api/v1/world/stream', {
    websocket: true,
    preValidation: async request => {
      // Cookie-authenticated upgrades need an Origin check even though an upgrade uses GET.
      // Agent clients can omit Origin, but browser-supplied foreign Origins are always rejected.
      if (request.headers.origin !== undefined && request.headers.origin !== ctx.config.publicOrigin)
        throw new AppError('ACCESS_DENIED', 403, '小镇连接必须来自同源页面');
      if (!request.headers.authorization && request.headers.origin !== ctx.config.publicOrigin)
        throw new AppError('ACCESS_DENIED', 403, '小镇连接需要同源 Origin');
    },
    preHandler: async request => {
      await withTransaction(ctx.pool, tx => lockActor(tx, request.actor, { allowPaused: true }));
    },
  }, (socket, request) => stream.connect(socket, request.actor, new URL(request.url, ctx.config.publicOrigin).searchParams.get('v') === '2'));
}
