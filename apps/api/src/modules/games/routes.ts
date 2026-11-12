import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { AdminGameModeration, BindGameMachine, CreateGame, GameEmpty, GameFunds, GameListQuery, IdParams, PatchGame, SettleGameSession, StartGameSession, SubmitGameScore,
  type AdminGameModerationInput, type CreateGameInput, type PatchGameInput, type SettleGameSessionInput, type SubmitGameScoreInput } from '@agentzero/contracts';
import { withTransaction } from '@agentzero/database';
import { lockActor } from '../../core.js';
import { command, type ApiContext } from '../../http.js';
import { adminGames, bindMachine, createGame, fundGame, getGameContent, getMachine, getSession, listGames, listSessions, moderateGame, patchGame, readGame, refundSession, settleSession, startSession, submitScore, withdrawGame } from './service.js';

export async function registerGameContent(app: FastifyInstance, ctx: ApiContext) {
  app.get<{ Params: { id: string; '*': string } }>('/game-content/:id/*', { schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }), '*': Type.String({ maxLength: 200 }) }) } }, async (request, reply) => {
    const file = await withTransaction(ctx.pool, tx => getGameContent(tx, request.params.id, request.params['*']));
    reply.header('access-control-allow-origin', '*').header('cross-origin-resource-policy', 'cross-origin')
      .header('content-security-policy', "sandbox allow-scripts; default-src 'none'; script-src 'self' https: blob: data: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https: data: blob:; frame-src 'none'; form-action 'none'; base-uri 'none'")
      .type(file.mime.startsWith('text/') || file.mime === 'application/json' ? `${file.mime}; charset=utf-8` : file.mime);
    return reply.send(file.data);
  });
}

export async function registerGames(app: FastifyInstance, ctx: ApiContext) {
  app.get('/api/v1/admin/assets/games', request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { admin: true }); return adminGames(tx);
  }));
  app.patch<{ Params: { id: string }; Body: AdminGameModerationInput }>('/api/v1/admin/assets/games/:id',
    { schema: { params: IdParams, body: AdminGameModeration } }, (request, reply) =>
      command(ctx, request, reply, { admin: true }, tx => moderateGame(tx, request.actor, request.id, request.params.id, request.body)));
  app.get<{ Querystring: { mine?: string } }>('/api/v1/games', { schema: { querystring: GameListQuery } }, request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true }); return listGames(tx, request.actor, request.query.mine === 'true');
  }));
  app.post<{ Body: CreateGameInput }>('/api/v1/games', { bodyLimit: 3 * 1024 * 1024, schema: { body: CreateGame } }, (request, reply) =>
    command(ctx, request, reply, { agentId: request.body.agent_id }, tx => createGame(tx, request.actor, request.id, request.body)));
  app.get<{ Params: { id: string } }>('/api/v1/games/:id', { schema: { params: IdParams } }, request => withTransaction(ctx.pool, async tx => {
    const { user } = await lockActor(tx, request.actor, { allowPaused: true });
    return readGame(tx, request.actor, request.params.id, request.actor.type === 'user' && user?.role === 'admin');
  }));
  app.patch<{ Params: { id: string }; Body: PatchGameInput }>('/api/v1/games/:id', { bodyLimit: 3 * 1024 * 1024, schema: { params: IdParams, body: PatchGame } }, (request, reply) =>
    command(ctx, request, reply, {}, tx => patchGame(tx, request.actor, request.id, request.params.id, request.body)));
  for (const [action, handle] of [['fund', fundGame], ['withdraw', withdrawGame]] as const) {
    app.post<{ Params: { id: string }; Body: { amount: string } }>(`/api/v1/games/:id/${action}`, { schema: { params: IdParams, body: GameFunds } }, (request, reply) =>
      command(ctx, request, reply, {}, tx => handle(tx, request.actor, request.id, request.params.id, request.body.amount)));
  }
  app.get<{ Params: { id: string } }>('/api/v1/games/machines/:id', { schema: { params: IdParams } }, request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true }); return getMachine(tx, request.params.id);
  }));
  app.put<{ Params: { id: string }; Body: { game_id: string | null } }>('/api/v1/games/machines/:id', { schema: { params: IdParams, body: BindGameMachine } }, (request, reply) =>
    command(ctx, request, reply, {}, tx => bindMachine(tx, request.actor, request.id, request.params.id, request.body.game_id)));
  app.post<{ Params: { id: string }; Body: { agent_id?: string; game_version: string } }>('/api/v1/games/:id/sessions', { schema: { params: IdParams, body: StartGameSession } }, (request, reply) =>
    command(ctx, request, reply, { agentId: request.body.agent_id }, tx => startSession(tx, request.actor, request.id, request.params.id, request.body.agent_id, request.body.game_version)));
  app.get<{ Querystring: { mine?: string } }>('/api/v1/games/sessions', { schema: { querystring: GameListQuery } }, request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true }); return listSessions(tx, request.actor);
  }));
  app.get<{ Params: { id: string } }>('/api/v1/games/:id/sessions', { schema: { params: IdParams } }, request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true }); return listSessions(tx, request.actor, request.params.id);
  }));
  app.get<{ Params: { id: string } }>('/api/v1/games/sessions/:id', { schema: { params: IdParams } }, request => withTransaction(ctx.pool, async tx => {
    await lockActor(tx, request.actor, { allowPaused: true }); return getSession(tx, request.actor, request.params.id);
  }));
  app.post<{ Params: { id: string }; Body: SubmitGameScoreInput }>('/api/v1/games/sessions/:id/score', { schema: { params: IdParams, body: SubmitGameScore } }, (request, reply) =>
    command(ctx, request, reply, {}, tx => submitScore(tx, request.actor, request.id, request.params.id, request.body)));
  app.post<{ Params: { id: string }; Body: SettleGameSessionInput }>('/api/v1/games/sessions/:id/settle', { schema: { params: IdParams, body: SettleGameSession } }, (request, reply) =>
    command(ctx, request, reply, {}, tx => settleSession(tx, request.actor, request.id, request.params.id, request.body)));
  app.post<{ Params: { id: string } }>('/api/v1/games/sessions/:id/refund', { schema: { params: IdParams, body: GameEmpty } }, (request, reply) =>
    command(ctx, request, reply, { allowPaused: true }, tx => refundSession(tx, request.actor, request.id, request.params.id)));
}
