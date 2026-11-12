import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, AdminAssetCatalog, GameDto, GameSessionDto, ItemInstanceDto, ItemTemplateDto, LandPlotDto, MarketListingDto, MarketTradeDto, WorldModelResult } from '../../packages/contracts/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import { reconcile } from '../../apps/api/src/modules/ledger/service.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { agent, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), origin = 'http://localhost:5173', reason = '核实后的资产管理测试';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string };
type TestAgent = Awaited<ReturnType<typeof agent>> & { token: string };
type Principal = Session | TestAgent;
let app: Awaited<ReturnType<typeof buildApp>>, admin: Session, alice: Session, bob: Session;
let a: TestAgent, b: TestAgent, adminAgent: TestAgent;
async function session(role: 'admin' | 'member' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor, token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
async function credential(owner: Session): Promise<TestAgent> {
  const value = await agent(pools.runtime, owner.actor), token = `azk_${value.actor.credentialId}.${randomBytes(32).toString('base64url')}`;
  await pools.migration.query('UPDATE agent_keys SET secret_hash=$2 WHERE id=$1', [value.actor.credentialId, tokenHash(token)]);
  return { ...value, token };
}
const headers = (who: Principal, key: string = randomUUID()) => 'token' in who ? { authorization: `Bearer ${who.token}`, 'idempotency-key': key }
  : { cookie: who.cookie, origin, 'x-csrf-token': who.csrf, 'idempotency-key': key };
const get = (who: Principal, path: string) => app.inject({ url: `/api/v1${path}`, headers: headers(who) });
const write = (who: Principal, method: 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, payload: Record<string, unknown>, key?: string) => app.inject({ method, url: `/api/v1${path}`, headers: headers(who, key), payload });
const post = (who: Principal, path: string, payload: Record<string, unknown>, key?: string) => write(who, 'POST', path, payload, key);
const patch = (path: string, payload: Record<string, unknown>, key?: string) => write(admin, 'PATCH', `/admin/assets${path}`, payload, key);
function body<T>(response: Awaited<ReturnType<typeof get>>): T { expect([200, 201], response.body).toContain(response.statusCode); return response.json<T>(); }
function reject(response: Awaited<ReturnType<typeof get>>, code: string) { expect([400, 403, 404, 409], response.body).toContain(response.statusCode); expect(response.json().error.code).toBe(code); }
const land = async (id: string) => body<LandPlotDto>(await get(alice, `/market/lands/${id}`));
const item = async (id: string) => body<ItemInstanceDto>(await get(alice, `/market/items/${id}`));
const catalog = async () => body<AdminAssetCatalog>(await get(admin, '/admin/assets'));
const conserved = async () => expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true);
async function supply() {
  const response = body<{ lands: LandPlotDto[] }>(await post(admin, '/admin/market/lands', { plots: [{ code: `ADMIN-${randomUUID().slice(0, 8)}`, x: 1000, y: 1000, area: 1600, points_price: '10', building_template: 'studio' }], reason }));
  return response.lands[0]!;
}
async function ownLand() {
  const offer = await supply();
  body(await post(alice, `/market/lands/${offer.id}/buy`, { agent_id: a.id, version: offer.version }));
  return land(offer.id);
}
async function ownItem() {
  const template = body<ItemTemplateDto>(await post(admin, '/admin/market/templates', { name: '测试盆栽', description: '付费实例', appearance: 'plant', points_price: '5', total_quantity: '10', reason }));
  const trade = body<MarketTradeDto>(await post(alice, `/market/templates/${template.id}/buy`, { agent_id: a.id, version: template.version }));
  return item(trade.item_id!);
}
async function sell(asset: LandPlotDto | ItemInstanceDto) {
  return body<MarketListingDto>(await post(alice, '/market/listings', { agent_id: a.id, ...('code' in asset ? { land_id: asset.id } : { item_id: asset.id }), asset_version: asset.version, points_price: '20' }));
}
async function model(plot: LandPlotDto, modelId = 'studio', roomId?: string) {
  return body<WorldModelResult>(await post(alice, `/world/studios/${plot.id}/models`, { land_version: (await land(plot.id)).version, model_id: modelId, x: 0, y: 0, rotation: 0, scale: 1, ...(roomId ? { room_id: roomId } : {}) }));
}
async function game() {
  const source = { type: 'bundle', entry: 'index.html', files: [{ path: 'index.html', mime: 'text/html', content: Buffer.from('<h1>测试游戏</h1>').toString('base64') }] };
  let value = body<GameDto>(await post(alice, '/games', { agent_id: a.id, name: '管理员回归游戏', description: '测试', entry_fee: '5', max_reward: '10', minimum_pool: '10', source }));
  value = body<GameDto>(await post(alice, `/games/${value.id}/fund`, { amount: '40' }));
  return body<GameDto>(await write(alice, 'PATCH', `/games/${value.id}`, { version: value.version, status: 'active' }));
}

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: '', githubClientSecret: '', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 } });
  await app.ready();
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await session('admin'); alice = await session(); bob = await session();
  a = await credential(alice); b = await credential(bob); adminAgent = await credential(admin);
  await fund(pools.runtime, admin.actor, a.id, '200'); await fund(pools.runtime, admin.actor, b.id, '100');
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('administrator asset moderation', () => {
  it('requires a human administrator, nonblank reason and current version without widening owner routes', async () => {
    const plot = await ownLand(), value = await ownItem(), playable = await game();
    const paths = ['/admin/assets', '/admin/assets/games'];
    for (const who of [alice, a, adminAgent]) for (const path of paths) reject(await get(who, path), 'ACCESS_DENIED');
    for (const who of [alice, a, adminAgent]) {
      reject(await write(who, 'PATCH', `/admin/assets/lands/${plot.id}`, { version: plot.version, reason, trading_frozen: true }), 'ACCESS_DENIED');
      reject(await write(who, 'PATCH', `/admin/assets/items/${value.id}`, { version: value.version, reason, trading_frozen: true }), 'ACCESS_DENIED');
      reject(await write(who, 'PATCH', `/admin/assets/games/${playable.id}`, { version: playable.version, reason, moderation_blocked: true }), 'ACCESS_DENIED');
    }
    expect((await patch(`/lands/${plot.id}`, { version: plot.version, reason: ' ', trading_frozen: true })).statusCode).toBe(400);
    expect((await patch(`/lands/${plot.id}`, { reason, trading_frozen: true })).statusCode).toBe(400);
    reject(await write(admin, 'PATCH', `/market/lands/${plot.id}/studio`, { agent_id: a.id, version: plot.version, name: '越权修改', works_url: null }), 'ACCESS_DENIED');
    reject(await write(admin, 'PATCH', `/games/${playable.id}`, { version: playable.version, status: 'paused' }), 'ACCESS_DENIED');
  });

  it('freezes initial sales and listings, preserves ownership and replays one auditable command', async () => {
    const offer = await supply(), key = randomUUID(), payload = { version: offer.version, reason, trading_frozen: true };
    const frozen = body<LandPlotDto>(await patch(`/lands/${offer.id}`, payload, key));
    expect(body(await patch(`/lands/${offer.id}`, payload, key))).toEqual(expect.objectContaining(frozen));
    reject(await patch(`/lands/${offer.id}`, { ...payload, reason: '改变了内容' }, key), 'IDEMPOTENCY_CONFLICT');
    reject(await post(alice, `/market/lands/${offer.id}/buy`, { agent_id: a.id, version: frozen.version }), 'ASSET_TRADING_FROZEN');
    const restored = body<LandPlotDto>(await patch(`/lands/${offer.id}`, { version: frozen.version, reason, trading_frozen: false }));
    body(await post(alice, `/market/lands/${offer.id}/buy`, { agent_id: a.id, version: restored.version }));
    const quote = await sell(await land(offer.id));
    const current = await land(offer.id);
    const held = body<LandPlotDto>(await patch(`/lands/${offer.id}`, { version: current.version, reason, trading_frozen: true }));
    expect(held).toMatchObject({ owner_user_id: alice.actor.userId, owner_agent_id: a.id, active_listing_id: null, trading_frozen: true });
    expect(body<MarketListingDto>(await get(alice, `/market/listings/${quote.id}`)).status).toBe('cancelled');
    reject(await post(bob, `/market/listings/${quote.id}/buy`, { agent_id: b.id, version: quote.version }), 'MARKET_VERSION_CONFLICT');
    reject(await post(alice, '/market/listings', { agent_id: a.id, land_id: offer.id, asset_version: held.version, points_price: '25' }), 'ASSET_TRADING_FROZEN');
    reject(await patch(`/lands/${offer.id}`, { version: current.version, reason, trading_frozen: false }), 'MARKET_VERSION_CONFLICT');
    const audits = await pools.runtime.query("SELECT details FROM audit_events WHERE action='admin.land_moderated' AND target_id=$1", [offer.id]);
    expect(audits.rowCount).toBe(3); expect(audits.rows.every(row => row.details.reason === reason)).toBe(true);
    await conserved();
  });

  it('cancels an item listing, freezes resale and returns paid decoration to the original inventory', async () => {
    const plot = await ownLand(), owned = await ownItem(), quote = await sell(owned);
    let value = await item(owned.id);
    value = body<ItemInstanceDto>(await patch(`/items/${value.id}`, { version: value.version, reason, trading_frozen: true }));
    expect(value.active_listing_id).toBeNull();
    expect(body<MarketListingDto>(await get(alice, `/market/listings/${quote.id}`)).status).toBe('cancelled');
    reject(await post(alice, '/market/listings', { agent_id: a.id, item_id: value.id, asset_version: value.version, points_price: '20' }), 'ASSET_TRADING_FROZEN');
    value = body<ItemInstanceDto>(await post(alice, `/market/items/${value.id}/place`, { agent_id: a.id, version: value.version, land_id: plot.id }));
    const landQuote = await sell(await land(plot.id));
    const before = (await pools.runtime.query('SELECT id,balance::text FROM ledger_accounts ORDER BY id')).rows;
    const result = body<ItemInstanceDto>(await post(admin, `/admin/assets/items/${value.id}/return`, { version: value.version, reason }));
    expect(result).toMatchObject({ id: owned.id, owner_agent_id: a.id, land_id: null, trading_frozen: true });
    expect(body<MarketListingDto>(await get(alice, `/market/listings/${landQuote.id}`)).status).toBe('cancelled');
    expect((await pools.runtime.query('SELECT id,balance::text FROM ledger_accounts ORDER BY id')).rows).toEqual(before);
    value = body<ItemInstanceDto>(await patch(`/items/${value.id}`, { version: result.version, reason, trading_frozen: false }));
    const fresh = await sell(value);
    body(await post(admin, `/admin/assets/listings/${fresh.id}/cancel`, { version: fresh.version, reason }));
    expect((await item(value.id)).owner_agent_id).toBe(a.id);
    await conserved();
  });

  it('masks every studio projection, blocks owner bypasses and restores preserved content', async () => {
    let plot = await ownLand();
    const room = await model(plot), machine = await model(plot, 'arcade'), owned = await ownItem();
    body(await post(alice, `/market/items/${owned.id}/place`, { agent_id: a.id, version: owned.version, land_id: plot.id }));
    plot = body<LandPlotDto>(await write(alice, 'PATCH', `/market/lands/${plot.id}/studio`, { agent_id: a.id, version: (await land(plot.id)).version, name: '原始工作室', works_url: 'https://example.com/original', showcase: [{ type: 'text', text: '待审核原文' }] }));
    const hidden = body<LandPlotDto>(await patch(`/lands/${plot.id}`, { version: plot.version, reason, showcase_hidden: true }));
    expect(hidden).toMatchObject({ name: '展示已屏蔽', works_url: null, showcase: [] });
    expect((await catalog()).lands.find(value => value.id === plot.id)).toMatchObject({ name: '原始工作室', showcase_hidden: true });
    for (const path of ['/world', `/world/agents/${a.id}`]) {
      const response = await get(bob, path);
      expect(response.statusCode, response.body).toBe(200);
      const found = response.json().lands.find((value: { id: string }) => value.id === plot.id);
      expect(found).toMatchObject({ name: '展示已屏蔽', works_url: null, showcase: [], models: [], decorations: [] });
    }
    const studio = (await get(bob, `/world/studios/${plot.id}`)).json().land;
    expect(studio).toMatchObject({ models: [], decorations: [], showcase: [] });
    expect((await get(alice, `/agents/${a.id}/assets`)).body).not.toContain('待审核原文');
    reject(await write(alice, 'PATCH', `/market/lands/${plot.id}/studio`, { agent_id: a.id, version: hidden.version, name: '绕过审核', works_url: null }), 'CONTENT_MODERATED');
    reject(await post(a, `/world/studios/${plot.id}/models`, { land_version: hidden.version, model_id: 'tree', x: 0, y: 0, rotation: 0, scale: 1 }), 'CONTENT_MODERATED');
    reject(await write(alice, 'PATCH', `/world/studios/${plot.id}/models/${room.placement.id}`, { version: room.placement.version, x: 0, y: 0, rotation: 10, scale: 1 }), 'CONTENT_MODERATED');
    reject(await write(alice, 'PUT', `/games/machines/${machine.placement.id}`, { game_id: null }), 'CONTENT_MODERATED');
    expect((await get(bob, `/games/machines/${machine.placement.id}`)).statusCode).toBe(404);
    body(await patch(`/lands/${plot.id}`, { version: hidden.version, reason, showcase_hidden: false }));
    expect(await land(plot.id)).toMatchObject({ name: '原始工作室', works_url: 'https://example.com/original', showcase: plot.showcase });
    const restored = (await get(bob, `/world/studios/${plot.id}`)).json().land;
    expect(restored.models).toHaveLength(2); expect(restored.decorations).toHaveLength(1);
  });

  it('removes free models using the existing nonempty-room rule with idempotent receipts', async () => {
    const plot = await ownLand(), room = await model(plot), child = await model(plot, 'plant', room.placement.id);
    const quote = await sell(await land(plot.id));
    reject(await write(admin, 'DELETE', `/admin/assets/lands/${plot.id}/models/${room.placement.id}`, { version: room.placement.version, reason }), 'WORLD_ROOM_NOT_EMPTY');
    expect(body<MarketListingDto>(await get(alice, `/market/listings/${quote.id}`)).status).toBe('active');
    const key = randomUUID(), path = `/admin/assets/lands/${plot.id}/models/${child.placement.id}`, payload = { version: child.placement.version, reason };
    const removed = body(await write(admin, 'DELETE', path, payload, key));
    expect(body(await write(admin, 'DELETE', path, payload, key))).toEqual(removed);
    expect(body<MarketListingDto>(await get(alice, `/market/listings/${quote.id}`)).status).toBe('cancelled');
    body(await write(admin, 'DELETE', `/admin/assets/lands/${plot.id}/models/${room.placement.id}`, { version: room.placement.version, reason }));
    expect((await catalog()).models).toHaveLength(0);
    expect(await land(plot.id)).toMatchObject({ owner_user_id: alice.actor.userId, owner_agent_id: a.id });
  });

  it('blocks new sessions and anonymous content while preserving existing settlements and refunds', async () => {
    let playable = await game();
    const plot = await ownLand(), machine = await model(plot, 'arcade');
    body(await write(alice, 'PUT', `/games/machines/${machine.placement.id}`, { game_id: playable.id }));
    const settled = body<GameSessionDto>(await post(bob, `/games/${playable.id}/sessions`, { agent_id: b.id, game_version: playable.version }));
    const refunded = body<GameSessionDto>(await post(bob, `/games/${playable.id}/sessions`, { agent_id: b.id, game_version: playable.version }));
    expect((await app.inject({ url: playable.entry_url })).statusCode).toBe(200);
    const originalPath = playable.entry_url;
    playable = body<GameDto>(await patch(`/games/${playable.id}`, { version: playable.version, reason, moderation_blocked: true }));
    expect(playable).toMatchObject({ moderation_blocked: true, accepting_players: false, entry_url: '', pool_balance: '40', pool_committed: '20' });
    expect((await app.inject({ url: originalPath })).statusCode).toBe(404);
    expect((await get(bob, `/games/machines/${machine.placement.id}`)).json().game).toBeNull();
    const outsider = await session();
    expect((await get(outsider, `/games/${playable.id}`)).statusCode).toBe(404);
    expect(body<GameDto>(await get(bob, `/games/${playable.id}`))).toMatchObject({ name: '已下架游戏', description: '', entry_url: '' });
    expect((await get(bob, '/games')).json().items).toHaveLength(0);
    playable = body<GameDto>(await write(alice, 'PATCH', `/games/${playable.id}`, { version: playable.version, status: 'active' }));
    expect(playable.moderation_blocked).toBe(true);
    reject(await post(bob, `/games/${playable.id}/sessions`, { agent_id: b.id, game_version: playable.version }), 'GAME_UNAVAILABLE');
    body(await post(bob, `/games/sessions/${settled.id}/score`, { score: '100', reward_requested: '5' }));
    expect(body<GameSessionDto>(await post(alice, `/games/sessions/${settled.id}/settle`, { reward_points: '5', reason })).status).toBe('settled');
    await pools.migration.query("UPDATE arcade_game_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [refunded.id]);
    expect(body<GameSessionDto>(await post(bob, `/games/sessions/${refunded.id}/refund`, {})).status).toBe('refunded');
    playable = body<GameDto>(await get(alice, `/games/${playable.id}`));
    playable = body<GameDto>(await patch(`/games/${playable.id}`, { version: playable.version, reason, moderation_blocked: false }));
    expect(playable).toMatchObject({ accepting_players: true, pool_committed: '0' });
    expect((await app.inject({ url: originalPath })).statusCode).toBe(200);
    expect((await get(bob, `/games/machines/${machine.placement.id}`)).json().game.id).toBe(playable.id);
    await conserved();
  });

  it('serializes a listing purchase racing moderation without changing a subsequent owner', async () => {
    const plot = await ownLand(), quote = await sell(plot), current = await land(plot.id);
    const [moderation, purchase] = await Promise.all([
      patch(`/lands/${plot.id}`, { version: current.version, reason, trading_frozen: true }),
      post(bob, `/market/listings/${quote.id}/buy`, { agent_id: b.id, version: quote.version }),
    ]);
    expect([moderation.statusCode, purchase.statusCode].sort()).toEqual(expect.arrayContaining([409]));
    const final = await land(plot.id);
    if (purchase.statusCode === 201) {
      expect(moderation.statusCode).toBe(409); expect(final).toMatchObject({ owner_user_id: bob.actor.userId, trading_frozen: false });
    } else {
      expect(moderation.statusCode, moderation.body).toBe(200); expect(final).toMatchObject({ owner_user_id: alice.actor.userId, trading_frozen: true });
    }
    await conserved();
  });

  it('transfers land with an audited cleanup, returning paid inventory and retaining funded game obligations', async () => {
    let plot = await ownLand();
    const room = await model(plot), machine = await model(plot, 'arcade', room.placement.id), owned = await ownItem(), playable = await game();
    body(await write(alice, 'PUT', `/games/machines/${machine.placement.id}`, { game_id: playable.id }));
    const session = body<GameSessionDto>(await post(bob, `/games/${playable.id}/sessions`, { agent_id: b.id, game_version: playable.version }));
    body(await post(alice, `/market/items/${owned.id}/place`, { agent_id: a.id, version: owned.version, land_id: plot.id }));
    plot = body<LandPlotDto>(await write(alice, 'PATCH', `/market/lands/${plot.id}/studio`, { agent_id: a.id, version: (await land(plot.id)).version,
      name: '原主人展示', works_url: 'https://example.com/original-owner', showcase: [{ type: 'text', text: '归属修正前的展板' }] }));
    body(await post(bob, '/world/presence', { room_id: room.placement.id, x: 0, y: 0 }));
    const quote = await sell(plot); plot = await land(plot.id);
    const beforeAccounts = (await pools.runtime.query('SELECT id,balance::text FROM ledger_accounts ORDER BY id')).rows;
    const beforeTrades = (await pools.runtime.query('SELECT id,transaction_id FROM market_trades ORDER BY id')).rows;
    const key = randomUUID(), input = { mode: 'transfer', version: plot.version, expected_owner_agent_id: a.id, target_agent_id: b.id, reason };
    const moved = body<LandPlotDto>(await post(admin, `/admin/assets/lands/${plot.id}/transfer`, input, key));
    expect(moved).toMatchObject({ owner_user_id: bob.actor.userId, owner_agent_id: b.id, name: '默认工作室', works_url: null, showcase: [], active_listing_id: null });
    expect(body(await post(admin, `/admin/assets/lands/${plot.id}/transfer`, input, key))).toEqual(expect.objectContaining(moved));
    expect(await item(owned.id)).toMatchObject({ owner_agent_id: a.id, land_id: null });
    expect((await catalog()).models).toHaveLength(0);
    expect((await pools.runtime.query('SELECT game_id FROM arcade_game_machines WHERE placement_id=$1', [machine.placement.id])).rowCount).toBe(0);
    expect(body<MarketListingDto>(await get(alice, `/market/listings/${quote.id}`)).status).toBe('cancelled');
    expect((await get(bob, '/world')).json().self).toMatchObject({ room_id: null, x: plot.x, y: plot.y + 1 });
    expect((await pools.runtime.query('SELECT id,balance::text FROM ledger_accounts ORDER BY id')).rows).toEqual(beforeAccounts);
    expect((await pools.runtime.query('SELECT id,transaction_id FROM market_trades ORDER BY id')).rows).toEqual(beforeTrades);
    expect(body<GameDto>(await get(alice, `/games/${playable.id}`))).toMatchObject({ owner_user_id: alice.actor.userId, pool_balance: '40', pool_committed: '10' });
    const audit = (await pools.runtime.query("SELECT details FROM audit_events WHERE action='admin.asset_transferred' AND target_id=$1", [plot.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ reason, expected_owner_agent_id: a.id, target_agent_id: b.id,
      previous_asset: { name: '原主人展示', works_url: 'https://example.com/original-owner', showcase: [{ type: 'text', text: '归属修正前的展板' }] } });
    expect(audit[0].details.returned_items).toHaveLength(1); expect(audit[0].details.removed_models).toHaveLength(2); expect(audit[0].details.removed_game_bindings).toHaveLength(1);
    body(await post(bob, `/games/sessions/${session.id}/score`, { score: '10', reward_requested: '5' }));
    expect(body<GameSessionDto>(await post(alice, `/games/sessions/${session.id}/settle`, { reward_points: '5', reason })).status).toBe('settled');
    await conserved();
  });

  it('requires explicit old ownership and eligible targets, and limits recovery to the acting administrator custody', async () => {
    const plot = await ownLand();
    const input = { mode: 'transfer', version: plot.version, expected_owner_agent_id: a.id, target_agent_id: b.id, reason };
    for (const who of [alice, a, adminAgent]) reject(await post(who, `/admin/assets/lands/${plot.id}/transfer`, input), 'ACCESS_DENIED');
    expect((await post(admin, `/admin/assets/lands/${plot.id}/transfer`, { mode: 'transfer', version: plot.version, target_agent_id: b.id, reason })).statusCode).toBe(400);
    reject(await post(admin, `/admin/assets/lands/${plot.id}/transfer`, { ...input, expected_owner_agent_id: adminAgent.id }), 'ASSET_OWNER_CONFLICT');
    reject(await post(admin, `/admin/assets/lands/${plot.id}/transfer`, { ...input, target_agent_id: a.id }), 'NO_CHANGE');
    await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [b.id]);
    reject(await post(admin, `/admin/assets/lands/${plot.id}/transfer`, input), 'ASSET_TARGET_UNAVAILABLE');
    await pools.migration.query("UPDATE agents SET deleted_at=clock_timestamp() WHERE id=$1", [b.id]);
    reject(await post(admin, `/admin/assets/lands/${plot.id}/transfer`, input), 'ASSET_TARGET_UNAVAILABLE');
    await pools.migration.query("UPDATE agents SET status='active',deleted_at=NULL WHERE id=$1", [b.id]);
    await pools.migration.query("UPDATE users SET status='suspended' WHERE id=$1", [bob.actor.userId]);
    reject(await post(admin, `/admin/assets/lands/${plot.id}/transfer`, input), 'ASSET_TARGET_UNAVAILABLE');
    await pools.migration.query("UPDATE users SET status='active' WHERE id=$1", [bob.actor.userId]);
    reject(await post(admin, `/admin/assets/lands/${plot.id}/transfer`, { ...input, mode: 'recover' }), 'ACCESS_DENIED');
    const frozen = body<LandPlotDto>(await patch(`/lands/${plot.id}`, { version: plot.version, reason, trading_frozen: true, showcase_hidden: true }));
    const moved = body<LandPlotDto>(await post(admin, `/admin/assets/lands/${plot.id}/transfer`, { ...input, version: frozen.version, mode: 'recover', target_agent_id: adminAgent.id }));
    expect(moved).toMatchObject({ owner_user_id: admin.actor.userId, owner_agent_id: adminAgent.id, trading_frozen: true, showcase_hidden: true });
    expect((await pools.runtime.query("SELECT details FROM audit_events WHERE action='admin.asset_recovered' AND target_id=$1", [plot.id])).rows[0].details).toMatchObject({ mode: 'recover', reason, target_user_id: admin.actor.userId });
    reject(await post(admin, `/admin/assets/lands/${plot.id}/transfer`, input), 'MARKET_VERSION_CONFLICT');
    await conserved();
  });

  it('transfers a placed item without changing balances or template supply and preserves its trading restriction', async () => {
    const plot = await ownLand(); let owned = await ownItem();
    owned = body<ItemInstanceDto>(await post(alice, `/market/items/${owned.id}/place`, { agent_id: a.id, version: owned.version, land_id: plot.id }));
    owned = body<ItemInstanceDto>(await patch(`/items/${owned.id}`, { version: owned.version, reason, trading_frozen: true }));
    const landQuote = await sell(await land(plot.id));
    const beforeAccounts = (await pools.runtime.query('SELECT id,balance::text FROM ledger_accounts ORDER BY id')).rows;
    const supplyBefore = (await pools.runtime.query('SELECT id,total_quantity::text,issued_quantity::text FROM item_templates ORDER BY id')).rows;
    const path = `/admin/assets/items/${owned.id}/transfer`, input = { mode: 'transfer', version: owned.version, expected_owner_agent_id: a.id, target_agent_id: b.id, reason };
    const moved = body<ItemInstanceDto>(await post(admin, path, input));
    expect(moved).toMatchObject({ owner_agent_id: b.id, land_id: null, trading_frozen: true });
    expect((await get(alice, `/market/items/${owned.id}`)).statusCode).toBe(404);
    expect(body<MarketListingDto>(await get(alice, `/market/listings/${landQuote.id}`)).status).toBe('cancelled');
    expect((await land(plot.id)).owner_agent_id).toBe(a.id);
    expect((await pools.runtime.query('SELECT id,balance::text FROM ledger_accounts ORDER BY id')).rows).toEqual(beforeAccounts);
    expect((await pools.runtime.query('SELECT id,total_quantity::text,issued_quantity::text FROM item_templates ORDER BY id')).rows).toEqual(supplyBefore);
    const restored = body<ItemInstanceDto>(await patch(`/items/${owned.id}`, { version: moved.version, reason, trading_frozen: false }));
    const itemQuote = body<MarketListingDto>(await post(bob, '/market/listings', { agent_id: b.id, item_id: owned.id, asset_version: restored.version, points_price: '10' }));
    const current = body<ItemInstanceDto>(await get(bob, `/market/items/${owned.id}`));
    const recovered = body<ItemInstanceDto>(await post(admin, path, { ...input, mode: 'recover', version: current.version, expected_owner_agent_id: b.id, target_agent_id: adminAgent.id }));
    expect(recovered).toMatchObject({ owner_agent_id: adminAgent.id, land_id: null });
    expect(body<MarketListingDto>(await get(admin, `/market/listings/${itemQuote.id}`)).status).toBe('cancelled');
    expect((await pools.runtime.query('SELECT id,balance::text FROM ledger_accounts ORDER BY id')).rows).toEqual(beforeAccounts);
    await conserved();
  });

  it('serializes administrative transfer against a paid listing purchase with no partial ownership or payment', async () => {
    const plot = await ownLand(), quote = await sell(plot), current = await land(plot.id);
    const [transfer, purchase] = await Promise.all([
      post(admin, `/admin/assets/lands/${plot.id}/transfer`, { mode: 'recover', version: current.version, expected_owner_agent_id: a.id, target_agent_id: adminAgent.id, reason }),
      post(bob, `/market/listings/${quote.id}/buy`, { agent_id: b.id, version: quote.version }),
    ]);
    const final = await land(plot.id);
    if (purchase.statusCode === 201) {
      expect(transfer.statusCode, transfer.body).toBe(409); expect(final).toMatchObject({ owner_agent_id: b.id, owner_user_id: bob.actor.userId });
    } else {
      expect(transfer.statusCode, transfer.body).toBe(200); expect(purchase.statusCode, purchase.body).toBe(409);
      expect(final).toMatchObject({ owner_agent_id: adminAgent.id, owner_user_id: admin.actor.userId });
      expect((await pools.runtime.query('SELECT id FROM market_trades WHERE listing_id=$1', [quote.id])).rowCount).toBe(0);
    }
    await conserved();
  });
});
