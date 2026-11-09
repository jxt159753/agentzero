import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, ItemInstanceDto, ItemTemplateDto, LandPlotDto, LandShowcaseItem, MarketAssetsDto, MarketCatalogDto, MarketListingDto, MarketTradeDto } from '../../packages/contracts/src/index.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import { getWallet, reconcile } from '../../apps/api/src/modules/ledger/service.js';
import { initializeDefaultLandSupply } from '../../apps/api/src/modules/market/default-land.js';
import { createAgentZeroServer } from '../../packages/agentzero/src/server.js';
import { agent, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools(), origin = 'http://localhost:5173';
type UserActor = Extract<Actor, { type: 'user' }>;
type Session = { actor: UserActor; cookie: string; csrf: string };
type TestAgent = Awaited<ReturnType<typeof agent>> & { token: string };
type Principal = Session | TestAgent;
let app: Awaited<ReturnType<typeof buildApp>>, apiUrl: string;
let admin: Session, alice: Session, bob: Session, carol: Session;
let a: TestAgent, sibling: TestAgent, b: TestAgent, c: TestAgent;
let plotSequence = 0;

async function session(role: 'admin' | 'member' = 'member'): Promise<Session> {
  const actor = await identity(pools.runtime, role) as UserActor;
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1', [actor.sessionId, tokenHash(token), tokenHash(csrf)]);
  return { actor, cookie: `az_session=${token}; az_csrf=${csrf}`, csrf };
}
async function credential(owner: Session): Promise<TestAgent> {
  const created = await agent(pools.runtime, owner.actor);
  const token = `azk_${created.actor.credentialId}.${randomBytes(32).toString('base64url')}`;
  await pools.migration.query('UPDATE agent_keys SET secret_hash=$2 WHERE id=$1', [created.actor.credentialId, tokenHash(token)]);
  return { ...created, token };
}
const headers = (client: Principal, key: string = randomUUID()) => 'token' in client
  ? { authorization: `Bearer ${client.token}`, 'idempotency-key': key }
  : { cookie: client.cookie, origin, 'x-csrf-token': client.csrf, 'idempotency-key': key };
const write = (client: Principal, method: 'POST' | 'PATCH' | 'PUT', path: string, payload: Record<string, unknown>, key?: string) => app.inject({ method, url: `/api/v1${path}`, headers: headers(client, key), payload });
const post = (client: Principal, path: string, payload: Record<string, unknown>, key?: string) => write(client, 'POST', path, payload, key);
const get = (client: Principal, path: string) => app.inject({ url: `/api/v1${path}`, headers: headers(client) });
const rejected = (response: { statusCode: number; body: string }) => expect([400, 401, 403, 404, 409], response.body).toContain(response.statusCode);
async function body<T>(response: Awaited<ReturnType<typeof get>>): Promise<T> {
  expect([200, 201], response.body).toContain(response.statusCode);
  return response.json<T>();
}
const catalog = (client: Principal = alice) => get(client, '/market').then(body<MarketCatalogDto>);
const assets = (client: Principal = alice, target = a) => get(client, `/agents/${target.id}/assets`).then(body<MarketAssetsDto>);
const land = (id: string) => get(alice, `/market/lands/${id}`).then(body<LandPlotDto>);
const item = (id: string, client: Principal = alice) => get(client, `/market/items/${id}`).then(body<ItemInstanceDto>);
const listing = (id: string) => get(alice, `/market/listings/${id}`).then(body<MarketListingDto>);
const wallet = (target: TestAgent) => withTransaction(pools.runtime, tx => getWallet(tx, target.id));
async function conserved() { expect((await withTransaction(pools.runtime, tx => reconcile(tx))).ok).toBe(true); }
function plot(points = '10') {
  const n = ++plotSequence;
  return { code: `TEST-${n}`, x: n, y: 6, area: 100, points_price: points, building_template: 'studio' };
}
async function supply(count = 1, points = '10') {
  const plots = Array.from({ length: count }, () => plot(points));
  await body(await post(admin, '/admin/market/lands', { plots, reason: '独立测试库地块供应' }));
  return (await catalog()).lands.filter(row => plots.some(p => p.code === row.code)).sort((x, y) => x.x - y.x);
}
async function template(quantity = '5', points = '5') {
  return body<ItemTemplateDto>(await post(admin, '/admin/market/templates', { name: '测试绿植', description: '仅测试装饰实例', appearance: 'plant', points_price: points, total_quantity: quantity, reason: '独立测试库模板供应' }));
}
const buy = (client: Principal, target: TestAgent, kind: 'lands' | 'templates' | 'listings', offer: { id: string; version: string }, key?: string) => post(client, `/market/${kind}/${offer.id}/buy`, { agent_id: target.id, version: offer.version }, key);
async function ownLand(client: Principal = alice, target = a) {
  const offer = (await supply())[0]!;
  await body(await buy(client, target, 'lands', offer));
  return land(offer.id);
}
async function ownItem(client: Principal = alice, target = a) {
  const offer = await template();
  const trade = await body<MarketTradeDto>(await buy(client, target, 'templates', offer));
  return item(trade.item_id!, client);
}
async function sell(asset: LandPlotDto | ItemInstanceDto, client: Principal = alice, target = a, points = '20') {
  return body<MarketListingDto>(await post(client, '/market/listings', { agent_id: target.id, ...('code' in asset ? { land_id: asset.id } : { item_id: asset.id }), asset_version: asset.version, points_price: points }));
}
const place = (asset: ItemInstanceDto, landId: string | null, client: Principal = alice, target = a) => post(client, `/market/items/${asset.id}/place`, { agent_id: target.id, version: asset.version, land_id: landId });

beforeAll(async () => {
  app = await buildApp({ pool: pools.runtime, config: { databaseUrl: process.env.TEST_DATABASE_URL!, publicOrigin: origin, githubClientId: 'test-client', githubClientSecret: 'test-secret', bootstrapAdminGithubId: '', production: false, host: '127.0.0.1', port: 0 } });
  apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
});
beforeEach(async () => {
  await resetLedgerTestData(pools.migration);
  admin = await session('admin'); alice = await session(); bob = await session(); carol = await session();
  a = await credential(alice); sibling = await credential(alice); b = await credential(bob); c = await credential(carol);
  for (const target of [a, sibling, b, c]) await fund(pools.runtime, admin.actor, target.id, '100');
});
afterAll(async () => { await app?.close(); await pools.runtime.end(); await pools.migration.end(); });

describe('phase 5 market with real PostgreSQL', () => {
  it('registers Agent purchases to the human owner and lets that owner manage the same property', async () => {
    const [offer] = await supply();
    await body(await buy(a, a, 'lands', offer!));
    const owned = await land(offer!.id);
    expect(owned).toMatchObject({ owner_user_id: alice.actor.userId, owner_agent_id: a.id });
    expect((await pools.runtime.query('SELECT owner_user_id,owner_agent_id FROM land_plots WHERE id=$1', [owned.id])).rows[0])
      .toEqual({ owner_user_id: alice.actor.userId, owner_agent_id: a.id });
    expect((await assets(alice, a)).lands).toContainEqual(owned);
    expect((await catalog()).user_land_count).toBe(1);
    const byOwner = await body<LandPlotDto>(await write(alice, 'PATCH', `/market/lands/${owned.id}/studio`, {
      agent_id: a.id, version: owned.version, name: '主人管理的土地', works_url: null,
    }));
    const byAgent = await body<LandPlotDto>(await write(a, 'PATCH', `/market/lands/${owned.id}/studio`, {
      agent_id: a.id, version: byOwner.version, name: 'Agent代主人管理的土地', works_url: null,
    }));
    const studio = (await get(bob, `/world/studios/${owned.id}`)).json();
    expect(studio.land.owner.id).toBe(alice.actor.userId);
    expect(studio.land.owner_agent_id).toBe(a.id);
    rejected(await write(bob, 'PATCH', `/market/lands/${owned.id}/studio`, {
      agent_id: a.id, version: byAgent.version, name: '其他用户不能修改', works_url: null,
    }));
    await expect(pools.migration.query('UPDATE land_plots SET owner_user_id=$2 WHERE id=$1', [owned.id, bob.actor.userId]))
      .rejects.toMatchObject({ code: '23503' });
    const resale = await sell(await land(owned.id), a, a, '20');
    await body(await buy(b, b, 'listings', resale));
    expect(await land(owned.id)).toMatchObject({ owner_user_id: bob.actor.userId, owner_agent_id: b.id });
    expect((await catalog(alice)).user_land_count).toBe(0);
    expect((await catalog(bob)).user_land_count).toBe(1);
    await conserved();
  });

  it('fills the town once while preserving existing ownership and individually edited prices', async () => {
    const owned = await ownLand();
    await Promise.all([
      withTransaction(pools.runtime, initializeDefaultLandSupply),
      withTransaction(pools.runtime, initializeDefaultLandSupply),
    ]);
    const first = await catalog();
    expect(first.lands.length).toBeGreaterThan(190);
    expect(first.lands.every(row => row.tradeable)).toBe(true);
    expect(await land(owned.id)).toEqual(owned);
    const offer = first.lands.find(row => !row.owner_agent_id)!;
    const changed = await body<LandPlotDto>(await write(admin, 'PATCH', `/admin/market/lands/${offer.id}`, {
      version: offer.version, points_price: '75', reason: '单块定价不被初始化覆盖',
    }));
    await withTransaction(pools.runtime, initializeDefaultLandSupply);
    expect((await catalog()).lands).toHaveLength(first.lands.length);
    expect(changed).toMatchObject(await land(offer.id));
    const snapshot = (await get(alice, '/world')).json();
    expect(snapshot.lands.find((row: { id: string }) => row.id === offer.id)).toMatchObject({
      width: changed.width, height: changed.height, points_price: '75', purchasable: true,
    });
    const conflict = await post(admin, '/admin/market/lands', { plots: [{ ...plot(), x: 20, y: 16 }], reason: '不能覆盖默认供应' });
    expect(conflict.json().error.code).toBe('LAND_SUPPLY_CONFLICT');
    await conserved();
  });

  it('allows only administrators to reprice an unsold plot and rejects stale purchase quotes without debiting', async () => {
    const [offer, other] = await supply(2);
    const change = { version: offer!.version, points_price: '25', reason: '单独调整靠近广场地块的价格' };
    expect((await write(alice, 'PATCH', `/admin/market/lands/${offer!.id}`, change)).statusCode).toBe(403);
    expect((await write(a, 'PATCH', `/admin/market/lands/${offer!.id}`, change)).statusCode).toBe(403);
    const key = randomUUID();
    const changed = await body<LandPlotDto>(await write(admin, 'PATCH', `/admin/market/lands/${offer!.id}`, change, key));
    expect(changed).toMatchObject({ points_price: '25', version: '2' });
    expect(await body(await write(admin, 'PATCH', `/admin/market/lands/${offer!.id}`, change, key))).toEqual(changed);
    expect((await land(other!.id)).points_price).toBe(other!.points_price);
    const before = await wallet(a);
    const stale = await buy(alice, a, 'lands', offer!);
    expect(stale.json().error.code).toBe('MARKET_VERSION_CONFLICT');
    expect(await wallet(a)).toEqual(before);
    const trade = await body<MarketTradeDto>(await buy(alice, a, 'lands', changed));
    expect(trade.points_price).toBe('25');
    const sold = await land(changed.id);
    const refused = await write(admin, 'PATCH', `/admin/market/lands/${sold.id}`, { ...change, version: sold.version, points_price: '30' });
    expect(refused.json().error.code).toBe('ASSET_UNAVAILABLE');
    expect((await pools.runtime.query("SELECT details FROM audit_events WHERE action='market.land_price_updated'")).rows).toHaveLength(1);
    await conserved();
  });

  it('rejects invalid prices and stale administrator edits', async () => {
    const [offer] = await supply();
    for (const price of ['0', '-1', '1.5', '9223372036854775808']) {
      rejected(await write(admin, 'PATCH', `/admin/market/lands/${offer!.id}`, { version: offer!.version, points_price: price, reason: '无效价格测试' }));
    }
    expect(await land(offer!.id)).toEqual(offer);
    await body(await write(admin, 'PATCH', `/admin/market/lands/${offer!.id}`, { version: offer!.version, points_price: '20', reason: '第一次改价' }));
    const stale = await write(admin, 'PATCH', `/admin/market/lands/${offer!.id}`, { version: offer!.version, points_price: '30', reason: '旧版本不能覆盖' });
    expect(stale.json().error.code).toBe('MARKET_VERSION_CONFLICT');
    expect((await land(offer!.id)).points_price).toBe('20');
  });

  it('serializes repricing against buying so an old quote is never charged a new price', async () => {
    const [offer] = await supply();
    const before = await wallet(a);
    const [change, purchase] = await Promise.all([
      write(admin, 'PATCH', `/admin/market/lands/${offer!.id}`, { version: offer!.version, points_price: '25', reason: '与购地并发改价' }),
      buy(alice, a, 'lands', offer!),
    ]);
    expect([change.statusCode, purchase.statusCode].sort()).toEqual(change.statusCode === 200 ? [200, 409] : [201, 409]);
    const current = await land(offer!.id);
    if (purchase.statusCode === 201) {
      expect(purchase.json().points_price).toBe('10');
      expect(current.owner_agent_id).toBe(a.id);
      expect((await wallet(a)).available).toBe((BigInt(before.available) - 10n).toString());
    } else {
      expect(purchase.json().error.code).toBe('MARKET_VERSION_CONFLICT');
      expect(current).toMatchObject({ owner_agent_id: null, points_price: '25' });
      expect(await wallet(a)).toEqual(before);
    }
    await conserved();
  });

  it('rejects overlap with an existing plot even when the two centers differ', async () => {
    const first = { ...plot(), x: 8, y: 8, area: 400 };
    await body(await post(admin, '/admin/market/lands', { plots: [first], reason: '确定地块占地' }));
    const response = await post(admin, '/admin/market/lands', { plots: [{ ...plot(), x: 9, y: 8, area: 400 }], reason: '相交地块测试' });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'LAND_SUPPLY_CONFLICT', message: expect.stringContaining('重叠') });
    expect((await catalog()).lands).toHaveLength(1);
  });

  it('rolls back an overlapping batch while allowing plots to share only their boundary', async () => {
    const first = { ...plot(), x: 12, y: 8, area: 400 };
    const overlap = { ...plot(), x: 13, y: 8, area: 400 };
    const response = await post(admin, '/admin/market/lands', { plots: [first, overlap], reason: '批内重叠整批回滚' });
    expect(response.json().error.code).toBe('LAND_SUPPLY_CONFLICT');
    expect((await catalog()).lands).toEqual([]);
    await body(await post(admin, '/admin/market/lands', { plots: [first, { ...overlap, x: 14 }], reason: '边界相接不重叠' }));
    expect((await catalog()).lands).toHaveLength(2);
  });

  it('permits at most one overlapping supply from different administrators concurrently', async () => {
    const secondAdmin = await session('admin');
    const responses = await Promise.all([
      post(admin, '/admin/market/lands', { plots: [{ ...plot(), x: 8, y: 8, area: 400 }], reason: '并发供应一' }),
      post(secondAdmin, '/admin/market/lands', { plots: [{ ...plot(), x: 9, y: 8, area: 400 }], reason: '并发供应二' }),
    ]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find(response => response.statusCode === 409)!.json().error.code).toBe('LAND_SUPPLY_CONFLICT');
    expect((await catalog()).lands).toHaveLength(1);
    expect((await pools.runtime.query("SELECT count(*)::integer n FROM audit_events WHERE action='market.land_supplied'")).rows[0].n).toBe(1);
  });

  it('reserves plazas, roads and public facilities while keeping non-public plots available', async () => {
    for (const position of [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 8 }, { x: -3, y: -2 }]) {
      const response = await post(admin, '/admin/market/lands', { plots: [plot(), { ...plot(), ...position }], reason: '公共区域边界校验' });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe('PUBLIC_LAND_NOT_TRADEABLE');
      expect((await catalog()).lands).toEqual([]);
    }
    // Its center is outside the plaza, but its 4x4 footprint still intersects public ground.
    const overlapping = await post(admin, '/admin/market/lands', { plots: [{ ...plot(), x: 3, y: 2, area: 1600 }], reason: '按整个占地判断' });
    expect(overlapping.json().error.code).toBe('PUBLIC_LAND_NOT_TRADEABLE');
    const supplied = (await supply())[0]!;
    expect(supplied).toMatchObject({ tradeable: true, owner_user_id: null, owner_github_login: null });
    await body(await buy(alice, a, 'lands', supplied));
    const owned = await land(supplied.id);
    expect(owned).toMatchObject({ owner_user_id: alice.actor.userId, tradeable: true });
    expect(owned.owner_github_login).toMatch(/^fixture-/);
    await conserved();
  });

  it('blocks purchases and listings of legacy plots overlapping public ground without moving funds', async () => {
    const id = randomUUID();
    await pools.migration.query("INSERT INTO land_plots(id,code,x,y,area,points_price,building_template,created_by) VALUES($1,'LEGACY-PUBLIC',0,0,100,10,'studio',$2)", [id, admin.actor.userId]);
    let legacy = await land(id);
    expect(legacy.tradeable).toBe(false);
    expect((await buy(alice, a, 'lands', legacy)).json().error.code).toBe('PUBLIC_LAND_NOT_TRADEABLE');
    await pools.migration.query('UPDATE land_plots SET owner_agent_id=$2,owner_user_id=$3 WHERE id=$1', [id, a.id, alice.actor.userId]);
    legacy = await land(id);
    const create = await post(alice, '/market/listings', { agent_id: a.id, land_id: id, asset_version: legacy.version, points_price: '20' });
    expect(create.json().error.code).toBe('PUBLIC_LAND_NOT_TRADEABLE');
    const quoteId = randomUUID();
    await pools.migration.query('INSERT INTO market_listings(id,seller_agent_id,land_id,points_price) VALUES($1,$2,$3,20)', [quoteId, a.id, id]);
    expect((await buy(bob, b, 'listings', await listing(quoteId))).json().error.code).toBe('PUBLIC_LAND_NOT_TRADEABLE');
    expect((await wallet(a)).available).toBe('100');
    expect((await wallet(b)).available).toBe('100');
    expect((await pools.runtime.query('SELECT count(*)::integer AS n FROM market_trades')).rows[0].n).toBe(0);
    await conserved();
  });

  it('starts empty and publishes validated administrator supply atomically', async () => {
    expect(await catalog()).toMatchObject({ settings: { user_land_limit: 3 }, lands: [], templates: [], listings: [], user_land_count: 0 });
    const input = plot();
    rejected(await post(alice, '/admin/market/lands', { plots: [input], reason: '非管理员' }));
    rejected(await post(admin, '/admin/market/lands', { plots: [{ ...input, points_price: '0' }], reason: '零价格' }));
    rejected(await post(admin, '/admin/market/lands', { plots: [input, input], reason: '同批次重复' }));
    expect((await catalog()).lands).toEqual([]);
    const created = await supply();
    expect(created[0]).toMatchObject({ owner_agent_id: null, area: 100, points_price: '10', version: '1' });
    const duplicate = { ...plot(), code: created[0]!.code };
    rejected(await post(admin, '/admin/market/lands', { plots: [plot(), duplicate], reason: '整批回滚' }));
    expect((await catalog()).lands).toHaveLength(1);
    await conserved();
  });

  it('commits first ownership, recovery payment, actor and receipt once for a repeated request', async () => {
    const offer = (await supply())[0]!, key = randomUUID();
    const first = await buy(a, a, 'lands', offer, key), replay = await buy(a, a, 'lands', offer, key);
    const trade = await body<MarketTradeDto & { operation_id: string }>(first);
    expect(replay.json()).toEqual(first.json());
    expect(trade).toMatchObject({ land_id: offer.id, buyer_agent_id: a.id, seller_agent_id: null, points_price: '10' });
    expect(await land(offer.id)).toMatchObject({ owner_agent_id: a.id });
    expect((await wallet(a)).available).toBe('90');
    expect((await wallet(a)).todaySpent).toBe('10');
    expect((await pools.runtime.query("SELECT balance FROM ledger_accounts WHERE system_key='RECOVERY'")).rows[0].balance).toBe('10');
    expect((await pools.runtime.query('SELECT actor_agent_id,credential_id FROM journal_transactions WHERE id=$1', [trade.transaction_id])).rows[0]).toEqual({ actor_agent_id: a.id, credential_id: a.actor.credentialId });
    expect((await get(alice, `/operations/${trade.operation_id}`)).json().result.id).toBe(trade.id);
    rejected(await get(bob, `/operations/${trade.operation_id}`));
    rejected(await buy(a, a, 'lands', offer));
    rejected(await post(a, `/market/lands/${offer.id}/buy`, { agent_id: a.id, version: '2' }, key));
    await conserved();
  });

  it('leaves no payment, ownership or receipt after insufficient funds', async () => {
    const offer = (await supply(1, '150'))[0]!, key = randomUUID();
    rejected(await buy(alice, a, 'lands', offer, key));
    expect((await wallet(a)).available).toBe('100');
    expect((await land(offer.id)).owner_agent_id).toBeNull();
    expect((await pools.runtime.query('SELECT count(*)::int AS n FROM idempotency_requests WHERE idempotency_key=$1', [key])).rows[0].n).toBe(0);
    await fund(pools.runtime, admin.actor, a.id, '100');
    await body(await buy(alice, a, 'lands', offer, key));
    expect((await wallet(a)).available).toBe('50');
    await conserved();
  });

  it('sells a contested system plot once without charging the losing buyer', async () => {
    const offer = (await supply())[0]!;
    const outcomes = await Promise.all([buy(a, a, 'lands', offer), buy(b, b, 'lands', offer)]);
    expect(outcomes.filter(r => r.statusCode === 201)).toHaveLength(1);
    rejected(outcomes.find(r => r.statusCode !== 201)!);
    expect([(await wallet(a)).available, (await wallet(b)).available].sort()).toEqual(['100', '90']);
    await conserved();
  });

  it('rolls back payment, ownership and listing closure if persisting a trade fails', async () => {
    const owned = await ownLand(), offer = await sell(owned), unsold = (await supply())[0]!;
    const journalCount = (await pools.runtime.query('SELECT count(*)::int AS n FROM journal_transactions')).rows[0].n;
    await pools.migration.query(`CREATE FUNCTION public.reject_test_market_trade() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'isolated trade persistence failure'; END $$;
      CREATE TRIGGER reject_test_market_trade AFTER INSERT ON market_trades FOR EACH ROW EXECUTE FUNCTION public.reject_test_market_trade()`);
    try {
      for (const [kind, quoted] of [['listings', offer], ['lands', unsold]] as const) {
        const key = randomUUID(), response = await buy(bob, b, kind, quoted, key);
        expect(response.statusCode, response.body).toBe(500);
        expect((await pools.runtime.query('SELECT count(*)::int AS n FROM idempotency_requests WHERE idempotency_key=$1', [key])).rows[0].n).toBe(0);
      }
      expect((await wallet(a)).available).toBe('90');
      expect(await wallet(b)).toMatchObject({ available: '100', reserved: '0', todaySpent: '0' });
      expect((await land(owned.id)).owner_agent_id).toBe(a.id);
      expect((await land(unsold.id)).owner_agent_id).toBeNull();
      expect((await listing(offer.id)).status).toBe('active');
      expect((await pools.runtime.query('SELECT count(*)::int AS n FROM journal_transactions')).rows[0].n).toBe(journalCount);
      await conserved();
    } finally {
      await pools.migration.query('DROP TRIGGER reject_test_market_trade ON market_trades; DROP FUNCTION public.reject_test_market_trade()');
    }
    await body(await buy(bob, b, 'listings', offer));
  });

  it('includes concurrent purchases in the same daily spend allowance', async () => {
    const offers = await supply(2);
    await pools.migration.query('UPDATE agent_policies SET daily_spend_limit=15 WHERE agent_id=$1', [a.id]);
    const outcomes = await Promise.all(offers.map(offer => buy(a, a, 'lands', offer)));
    expect(outcomes.filter(r => r.statusCode === 201)).toHaveLength(1);
    rejected(outcomes.find(r => r.statusCode !== 201)!);
    expect(await wallet(a)).toMatchObject({ available: '90', todaySpent: '10' });
    await conserved();
  });

  it('serializes the shared user land limit across Agents and never confiscates land after lowering it', async () => {
    const offers = await supply(4);
    await body(await buy(a, a, 'lands', offers[0]!));
    await body(await buy(sibling, sibling, 'lands', offers[1]!));
    const outcomes = await Promise.all([buy(a, a, 'lands', offers[2]!), buy(sibling, sibling, 'lands', offers[3]!)]);
    expect(outcomes.filter(r => r.statusCode === 201)).toHaveLength(1);
    rejected(outcomes.find(r => r.statusCode !== 201)!);
    expect((await catalog()).user_land_count).toBe(3);
    const settings = (await catalog()).settings;
    await body(await write(admin, 'PUT', '/admin/market/settings', { version: settings.version, user_land_limit: 1, reason: '只影响新购资格' }));
    expect((await catalog()).user_land_count).toBe(3);
    const remaining = (await catalog()).lands.find(row => row.owner_agent_id === null)!;
    rejected(await buy(alice, a, 'lands', remaining));
    await body(await buy(bob, b, 'lands', remaining));
    await conserved();
  });

  it('invalidates cancelled quotes, forbids same-user trading and permits only the new fixed price', async () => {
    const owned = await ownLand(), first = await sell(owned);
    rejected(await buy(sibling, sibling, 'listings', first));
    await body(await post(alice, `/market/listings/${first.id}/cancel`, { version: first.version }));
    rejected(await buy(bob, b, 'listings', first));
    const second = await sell(await land(owned.id), alice, a, '30');
    rejected(await post(bob, `/market/listings/${second.id}/buy`, { agent_id: b.id, version: second.version, points_price: '1' }));
    await body(await buy(bob, b, 'listings', second));
    expect((await wallet(a)).available).toBe('120');
    expect((await wallet(b)).available).toBe('70');
    expect((await listing(second.id)).status).toBe('sold');
    await conserved();
  });

  it('freezes a listed studio and transfers a default studio while returning decorations to its paused seller', async () => {
    const owned = await ownLand(), decoration = await ownItem();
    await body(await place(decoration, owned.id));
    const personalized = await body<LandPlotDto>(await write(alice, 'PATCH', `/market/lands/${owned.id}/studio`, { agent_id: a.id, version: (await land(owned.id)).version, name: '卖方的作品室', works_url: 'https://example.com/my-work', showcase: [{ type: 'text', text: '卖方的展示' }] }));
    const offer = await sell(personalized);
    rejected(await write(alice, 'PATCH', `/market/lands/${owned.id}/studio`, { agent_id: a.id, version: (await land(owned.id)).version, name: '不能修改', works_url: null, showcase: [] }));
    rejected(await place(await item(decoration.id), null));
    await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [a.id]);
    await pools.migration.query('UPDATE agent_policies SET can_trade=false WHERE agent_id=$1', [a.id]);
    await pools.migration.query('UPDATE agent_keys SET revoked_at=clock_timestamp() WHERE id=$1', [a.actor.credentialId]);
    const outcomes = await Promise.all([buy(b, b, 'listings', offer), buy(c, c, 'listings', offer)]);
    expect(outcomes.filter(r => r.statusCode === 201)).toHaveLength(1);
    rejected(outcomes.find(r => r.statusCode !== 201)!);
    const buyer = outcomes[0]!.statusCode === 201 ? b : c;
    expect(await land(owned.id)).toMatchObject({ owner_agent_id: buyer.id, works_url: null, showcase: [], active_listing_id: null });
    expect((await land(owned.id)).name).not.toBe('卖方的作品室');
    expect(await item(decoration.id)).toMatchObject({ owner_agent_id: a.id, land_id: null });
    expect((await wallet(a)).available).toBe('105');
    expect((await wallet(buyer)).available).toBe('80');
    await conserved();
  });

  it('lets the owner cancel an existing listing while the seller Agent is paused', async () => {
    const offer = await sell(await ownLand());
    await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [a.id]);
    rejected(await post(a, `/market/listings/${offer.id}/cancel`, { version: offer.version }));
    await body(await post(alice, `/market/listings/${offer.id}/cancel`, { version: offer.version }));
    expect((await listing(offer.id)).status).toBe('cancelled');
    expect((await wallet(a)).available).toBe('90');
  });

  it('allows one active listing and serializes cancellation against purchase', async () => {
    const owned = await ownLand();
    const payload = { agent_id: a.id, land_id: owned.id, asset_version: owned.version, points_price: '20' };
    const duplicates = await Promise.all([post(alice, '/market/listings', payload), post(alice, '/market/listings', payload)]);
    expect(duplicates.filter(r => r.statusCode === 201)).toHaveLength(1);
    const offer = duplicates.find(r => r.statusCode === 201)!.json<MarketListingDto>();
    const outcomes = await Promise.all([post(alice, `/market/listings/${offer.id}/cancel`, { version: offer.version }), buy(bob, b, 'listings', offer)]);
    expect(outcomes.filter(r => r.statusCode < 300)).toHaveLength(1);
    const current = await listing(offer.id);
    expect((await wallet(b)).available).toBe(current.status === 'sold' ? '80' : '100');
    expect((await land(owned.id)).owner_agent_id).toBe(current.status === 'sold' ? b.id : a.id);
    await conserved();
  });

  it('issues only one instance from the final template unit and preserves immutable template terms', async () => {
    const offer = await template('1'), outcomes = await Promise.all([buy(a, a, 'templates', offer), buy(b, b, 'templates', offer)]);
    expect(outcomes.filter(r => r.statusCode === 201)).toHaveLength(1);
    rejected(outcomes.find(r => r.statusCode !== 201)!);
    expect([(await wallet(a)).available, (await wallet(b)).available].sort()).toEqual(['100', '95']);
    expect((await catalog()).templates[0]).toMatchObject({ remaining_quantity: '0', issued_quantity: '1' });
    rejected(await write(admin, 'PATCH', `/admin/market/templates/${offer.id}`, { version: (await catalog()).templates[0]!.version, status: 'active', add_quantity: '1', points_price: '1', reason: '不可改旧模板价格' }));
    await conserved();
  });

  it('requires current template versions, respects paused supply and replays a purchased instance', async () => {
    const offer = await template('0');
    rejected(await buy(alice, a, 'templates', offer));
    const replenished = await body<ItemTemplateDto>(await write(admin, 'PATCH', `/admin/market/templates/${offer.id}`, { version: offer.version, status: 'paused', add_quantity: '2', reason: '补库存后暂停销售' }));
    rejected(await buy(alice, a, 'templates', replenished));
    rejected(await write(admin, 'PATCH', `/admin/market/templates/${offer.id}`, { version: offer.version, status: 'active', add_quantity: '0', reason: '过期版本' }));
    const active = await body<ItemTemplateDto>(await write(admin, 'PATCH', `/admin/market/templates/${offer.id}`, { version: replenished.version, status: 'active', add_quantity: '0', reason: '开始销售' }));
    rejected(await buy(alice, a, 'templates', replenished));
    const key = randomUUID(), first = await buy(alice, a, 'templates', active, key), replay = await buy(alice, a, 'templates', active, key);
    await body(first);
    expect(replay.json()).toEqual(first.json());
    expect((await assets()).items).toHaveLength(1);
    expect((await catalog()).templates[0]!.remaining_quantity).toBe('1');
    expect((await wallet(a)).available).toBe('95');
    await conserved();
  });

  it('requires items to be unplaced before listing and prevents listed items being placed', async () => {
    const owned = await ownLand(), decoration = await ownItem(), foreign = await ownLand(bob, b);
    rejected(await place(decoration, foreign.id));
    await body(await place(decoration, owned.id));
    const placed = await item(decoration.id);
    rejected(await post(alice, '/market/listings', { agent_id: a.id, item_id: placed.id, asset_version: placed.version, points_price: '12' }));
    await body(await place(placed, null));
    const offer = await sell(await item(decoration.id), alice, a, '12');
    rejected(await place(await item(decoration.id), owned.id));
    rejected(await buy(sibling, sibling, 'listings', offer));
    const trade = await body<MarketTradeDto>(await buy(bob, b, 'listings', offer));
    expect(trade.item_id).toBe(decoration.id);
    expect(await item(decoration.id, bob)).toMatchObject({ owner_agent_id: b.id, land_id: null });
    expect((await wallet(a)).available).toBe('97');
    await conserved();
  });

  it('completes opposite-direction purchases without deadlocks or double daily charges', async () => {
    const left = await sell(await ownItem(), alice, a, '10');
    const right = await sell(await ownItem(bob, b), bob, b, '10');
    const outcomes = await Promise.all([buy(alice, a, 'listings', right), buy(bob, b, 'listings', left)]);
    for (const outcome of outcomes) await body(outcome);
    for (const target of [a, b]) expect(await wallet(target)).toMatchObject({ available: '95', reserved: '0', todaySpent: '15', outstandingHeld: '0' });
    await conserved();
  });

  it('enforces ownership, permission, limits, CSRF, pause and revocation for new commitments', async () => {
    const offer = (await supply())[0]!;
    rejected(await buy(bob, a, 'lands', offer));
    rejected(await buy(sibling, a, 'lands', offer));
    expect((await app.inject({ method: 'POST', url: `/api/v1/market/lands/${offer.id}/buy`, headers: { cookie: alice.cookie, origin, 'idempotency-key': randomUUID() }, payload: { agent_id: a.id, version: offer.version } })).statusCode).toBe(403);
    await pools.migration.query('UPDATE agent_policies SET can_trade=false WHERE agent_id=$1', [a.id]);
    rejected(await buy(a, a, 'lands', offer));
    rejected(await buy(alice, a, 'lands', offer));
    await pools.migration.query('UPDATE agent_policies SET can_trade=true,single_spend_limit=9 WHERE agent_id=$1', [a.id]);
    rejected(await buy(alice, a, 'lands', offer));
    await pools.migration.query('UPDATE agent_policies SET single_spend_limit=1000,daily_spend_limit=9 WHERE agent_id=$1', [a.id]);
    rejected(await buy(alice, a, 'lands', offer));
    await pools.migration.query('UPDATE agent_policies SET daily_spend_limit=1000 WHERE agent_id=$1', [a.id]);
    await pools.migration.query("UPDATE agents SET status='paused' WHERE id=$1", [a.id]);
    rejected(await buy(alice, a, 'lands', offer));
    await pools.migration.query("UPDATE agents SET status='active' WHERE id=$1", [a.id]);
    await pools.migration.query('UPDATE agent_keys SET revoked_at=clock_timestamp() WHERE id=$1', [a.actor.credentialId]);
    rejected(await buy(a, a, 'lands', offer));
    expect((await wallet(a)).available).toBe('100');
    await body(await buy(alice, a, 'lands', offer));
    await conserved();
  });

  it('restricts private inventory and rejects unowned editing and unsafe works links', async () => {
    const owned = await ownLand(), decoration = await ownItem();
    rejected(await get(bob, `/agents/${a.id}/assets`));
    rejected(await get(sibling, `/agents/${a.id}/assets`));
    expect((await assets(a)).items.map(x => x.id)).toContain(decoration.id);
    rejected(await write(bob, 'PATCH', `/market/lands/${owned.id}/studio`, { agent_id: b.id, version: owned.version, name: '越权', works_url: null }));
    rejected(await write(alice, 'PATCH', `/market/lands/${owned.id}/studio`, { agent_id: a.id, version: owned.version, name: '链接', works_url: 'javascript:alert(1)' }));
    rejected(await place(decoration, null, bob, b));
    expect((await land(owned.id)).works_url).toBeNull();
  });

  it('saves ordered mixed showcase items, replays once, preserves old clients and clears explicitly', async () => {
    const owned = await ownLand(), path = `/market/lands/${owned.id}/studio`, key = randomUUID();
    expect(owned.showcase).toEqual([]);
    const showcase: LandShowcaseItem[] = [
      { type: 'text', title: ' 关于我们 ', text: ' 欢迎参观\n第二行 ' },
      { type: 'image', title: '图片', url: 'https://example.com/photo.png' },
      { type: 'video', url: 'https://example.com/clip.mp4' },
      { type: 'webpage', title: '项目网页', url: 'https://example.com/work' },
    ];
    const input = { agent_id: a.id, version: owned.version, name: '多媒体地块', works_url: 'https://example.com/legacy', showcase };
    const saved = await body<LandPlotDto>(await write(alice, 'PATCH', path, input, key));
    const expected = [{ type: 'text', title: '关于我们', text: '欢迎参观\n第二行' }, ...showcase.slice(1)];
    expect(saved.showcase).toEqual(expected);
    expect(await body(await write(alice, 'PATCH', path, input, key))).toEqual(saved);
    expect((await land(owned.id)).version).toBe(saved.version);
    expect((await catalog(bob)).lands.find(plot => plot.id === owned.id)?.showcase).toEqual(expected);
    expect((await assets()).lands.find(plot => plot.id === owned.id)?.showcase).toEqual(expected);
    expect((await pools.runtime.query('SELECT showcase FROM land_plots WHERE id=$1', [owned.id])).rows[0].showcase).toEqual(expected);
    const oldClient = await body<LandPlotDto>(await write(a, 'PATCH', path, { agent_id: a.id, version: saved.version, name: '旧客户端更新名称', works_url: null }));
    expect(oldClient.showcase).toEqual(expected);
    const cleared = await body<LandPlotDto>(await write(alice, 'PATCH', path, { agent_id: a.id, version: oldClient.version, name: oldClient.name, works_url: null, showcase: [] }));
    expect(cleared.showcase).toEqual([]);
    expect(cleared.works_url).toBeNull();
  });

  it('rejects unauthorized, stale, malformed and oversized showcase edits without changing the plot', async () => {
    const owned = await ownLand(), path = `/market/lands/${owned.id}/studio`;
    const input = { agent_id: a.id, version: owned.version, name: owned.name, works_url: null };
    const valid = [{ type: 'text', text: '公开内容' }];
    expect((await write(bob, 'PATCH', path, { ...input, agent_id: b.id, showcase: valid })).statusCode).toBe(403);
    expect((await write(sibling, 'PATCH', path, { ...input, showcase: valid })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1${path}`, headers: { cookie: alice.cookie, origin, 'idempotency-key': randomUUID() }, payload: { ...input, showcase: valid } })).statusCode).toBe(403);
    for (const showcase of [null, {}, Array.from({ length: 9 }, () => valid[0]),
      [{ type: 'text', text: ' ' }], [{ type: 'text', text: 'x'.repeat(2001) }], [{ type: 'text', text: 'x', title: 'x'.repeat(81) }],
      [{ type: 'image' }], [{ type: 'video', url: 'http://example.com/video.mp4' }],
      [{ type: 'image', url: 'data:image/png;base64,AAAA' }], [{ type: 'webpage', url: 'javascript:alert(1)' }],
      [{ type: 'webpage', url: 'https://example.com/' + 'x'.repeat(2000) }], [{ type: 'html', text: '<script>alert(1)</script>' }],
      [{ type: 'text', text: 'x', url: 'https://example.com' }], [{ type: 'webpage', url: 'https://example.com', html: '<script>alert(1)</script>' }]]) {
      const response = await write(alice, 'PATCH', path, { ...input, showcase });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(await land(owned.id)).toEqual(owned);
    const saved = await body<LandPlotDto>(await write(alice, 'PATCH', path, { ...input, showcase: Array.from({ length: 8 }, () => valid[0]) }));
    expect(saved.showcase).toHaveLength(8);
    expect((await write(alice, 'PATCH', path, { ...input, showcase: [] })).statusCode).toBe(409);
    expect((await land(owned.id)).showcase).toHaveLength(8);
  });

  it('does not expose the buyer private inventory through an old listing or the seller asset history', async () => {
    const decoration = await ownItem(), offer = await sell(decoration), buyerLand = await ownLand(bob, b);
    await body(await buy(bob, b, 'listings', offer));
    await body(await place(await item(decoration.id, bob), buyerLand.id, bob, b));
    rejected(await get(alice, `/market/items/${decoration.id}`));
    rejected(await get(carol, `/market/items/${decoration.id}`));
    expect((await listing(offer.id)).item).toBeNull();
    expect((await assets()).listings.find(row => row.id === offer.id)!.item).toBeNull();
    expect((await get(carol, `/market/listings/${offer.id}`)).json().item).toBeNull();
  });

  it('uses the same identity-bound market flow through MCP and real HTTP', async () => {
    const offered = (await supply())[0]!;
    const server = createAgentZeroServer({ apiUrl, agentKey: a.token });
    const client = new Client({ name: 'market-postgres-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const args = { kind: 'land', asset_id: offered.id, version: offered.version, idempotency_key: randomUUID() };
      const result = await client.callTool({ name: 'agentzero_buy_market_asset', arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const replay = await client.callTool({ name: 'agentzero_buy_market_asset', arguments: args });
      expect(replay.structuredContent).toEqual(result.structuredContent);
      const inventory = await client.callTool({ name: 'agentzero_market_assets', arguments: {} });
      expect(inventory.isError, JSON.stringify(inventory)).not.toBe(true);
      expect(inventory.structuredContent).toMatchObject({ agent_id: a.id, lands: [{ id: offered.id, owner_agent_id: a.id, owner_user_id: alice.actor.userId }] });
      const owned = await land(offered.id), showcase = [{ type: 'text', text: '通过插件设置的展示' }, { type: 'image', url: 'https://example.com/photo.png' }];
      const displayArgs = { land_id: owned.id, version: owned.version, name: '插件展示', works_url: null, showcase, idempotency_key: randomUUID() };
      const displayed = await client.callTool({ name: 'agentzero_update_studio', arguments: displayArgs });
      expect(displayed.isError, JSON.stringify(displayed)).not.toBe(true);
      expect(displayed.structuredContent).toMatchObject({ id: owned.id, showcase });
      expect((await client.callTool({ name: 'agentzero_update_studio', arguments: displayArgs })).structuredContent).toEqual(displayed.structuredContent);
      expect((await land(owned.id)).showcase).toEqual(showcase);
      expect((await wallet(a)).available).toBe('90');
      await conserved();
    } finally { await client.close(); await server.close(); }
  });
});
