import { test, expect, type Page } from '@playwright/test';
import { WORLD_BOUNDS, WORLD_PUBLIC_AREAS, WORLD_PLACES, type GameDto, type GameSessionDto, type WorldSnapshot } from '../../packages/contracts/src/index.js';

const userId = '11000000-0000-4000-8000-000000000001', agentId = '21000000-0000-4000-8000-000000000001';
const gameId = '31000000-0000-4000-8000-000000000001', sessionId = '41000000-0000-4000-8000-000000000001';
const world: WorldSnapshot = { server_time: new Date().toISOString(), presence_ttl_seconds: 60, self: { kind: 'visitor', id: userId, online: true, x: 0, y: 0 }, lands: [], agents: [], visitors: [], bounds: WORLD_BOUNDS, public_areas: WORLD_PUBLIC_AREAS, places: WORLD_PLACES };
async function fixture(page: Page, own = false, machine = false) {
  const snapshot = structuredClone(world), placementId = '51000000-0000-4000-8000-000000000001';
  const game: GameDto = { id: gameId, name: '星光试验场', description: '积分奖励由发布者结算', author_agent_id: own ? agentId : '21000000-0000-4000-8000-000000000002', owner_user_id: own ? userId : '11000000-0000-4000-8000-000000000002', entry_fee: '2', max_reward: '10', minimum_pool: '20', status: 'active', version: '1', pool_balance: '30', pool_committed: '0', available_pool: '30', accepting_players: true, settlement_rule: 'manual', source_type: 'bundle', entry_url: `/game-content/${gameId}/index.html`, created_at: new Date().toISOString() };
  let session: GameSessionDto | undefined;
  const starts = new Map<string, GameSessionDto>();
  const controls = { startError: null as string | null, loseStartResponse: false, waitForStart: Promise.resolve(), agents: 'normal' as 'normal' | 'empty' | 'error', userAvailable: '1000', userReserved: '0', agentAvailable: '1000' };
  const updateSession = (value: Partial<GameSessionDto>) => {
    if (!session) throw new Error('Start a session first');
    if (!session.player_agent_id && ['playing', 'submitted'].includes(session.status) && value.status && ['settled', 'refunded'].includes(value.status)) {
      controls.userReserved = (BigInt(controls.userReserved) - BigInt(session.entry_fee)).toString();
      controls.userAvailable = (BigInt(controls.userAvailable) + BigInt(value.status === 'refunded' ? session.entry_fee : value.reward_points ?? '0')).toString();
    }
    session = { ...session, ...value };
  };
  if (machine) snapshot.lands.push({ id: '61000000-0000-4000-8000-000000000001', code: 'GAME-LAND', x: 0, y: -1, width: 4, height: 4, area: 1600, name: '游戏花园', works_url: null, owner_agent_id: game.author_agent_id, owner_name: '游戏发布者', owner: { id: game.owner_user_id, github_login: 'creator', display_name: '创作者' }, points_price: '10', version: '1', tradeable: true, purchasable: false, listing: null, decorations: [], models: [{ id: placementId, model_id: 'arcade', x: 0.25, y: 0.65, rotation: 0, scale: 1, version: '1' }] });
  const writes: { path: string; body: Record<string, unknown>; key: string | undefined }[] = [];
  const reads: string[] = [];
  await page.context().addCookies([{ name: 'az_csrf', value: 'games-csrf', url: 'http://localhost:5173' }]);
  await page.routeWebSocket('**/api/v1/world/stream?v=2', socket => { socket.send(JSON.stringify({ type: 'snapshot', world: snapshot })); socket.onMessage(() => {}); });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1', ''), method = request.method();
    const body = method === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    const respond = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (method !== 'GET') writes.push({ path, body, key: request.headers()['idempotency-key'] });
    else reads.push(path);
    if (path === '/me') return respond({ actor: { type: 'user', userId }, user: { id: userId, github_login: 'player', display_name: '测试玩家', status: 'active', role: 'member' } });
    if (path === '/world') return respond(snapshot);
    if (path === `/games/machines/${placementId}`) return respond({ placement_id: placementId, game });
    if (path === '/agents') return controls.agents === 'error' ? respond({ error: { code: 'SERVER_ERROR' } }, 503) : respond({ items: controls.agents === 'empty' ? [] : [{ id: agentId, owner_user_id: userId, name: '游戏账户', status: 'active', version: '1', deleted_at: null }], next_cursor: null });
    if (path === '/wallet') return respond({ user_id: userId, available: controls.userAvailable, reserved: controls.userReserved, initial_grant: '1000' });
    if (path === `/agents/${agentId}/wallet`) return respond({ available: controls.agentAvailable, reserved: '0', daily_spent: '0', daily_usage: '0', held: '0', business_date: '2026-11-09' });
    if (path === '/wallet/transactions') return respond({ items: session && !session.player_agent_id ? [{ id: session.id, kind: 'RESERVE', business_key: `game:${session.id}:reserve`, reason: '游戏费用冻结', created_at: session.created_at, entries: [{ bucket: 'USER_AVAILABLE', side: 'credit', amount: session.entry_fee }, { bucket: 'USER_RESERVED', side: 'debit', amount: session.entry_fee }] }] : [], next_cursor: null });
    if (path === '/games' && method === 'GET') return respond({ items: [game] });
    if (path === '/games' && method === 'POST') return respond({ ...game, name: body.name, owner_user_id: userId }, 201);
    if (path === `/games/${gameId}` && method === 'GET') return respond(game);
    if (path === `/games/${gameId}` && method === 'PATCH') { Object.assign(game, body, { version: String(Number(game.version) + 1) }); return respond(game); }
    if (path === `/games/${gameId}/fund` || path === `/games/${gameId}/withdraw`) {
      game.pool_balance = String(BigInt(game.pool_balance) + (path.endsWith('/fund') ? 1n : -1n) * BigInt(String(body.amount))); game.available_pool = String(BigInt(game.pool_balance) - BigInt(game.pool_committed)); game.accepting_players = BigInt(game.available_pool) >= BigInt(game.minimum_pool); return respond(game);
    }
    if (path === `/games/${gameId}/sessions` && method === 'POST') {
      await controls.waitForStart;
      if (controls.startError) { const code = controls.startError; controls.startError = null; return respond({ error: { code } }, 409); }
      const key = request.headers()['idempotency-key'];
      if (starts.has(key)) return respond(starts.get(key), 201);
      session = { id: `41000000-0000-4000-8000-${String(starts.size + 1).padStart(12, '0')}`, game_id: gameId, player_agent_id: typeof body.agent_id === 'string' ? body.agent_id : null, player_user_id: userId, entry_fee: game.entry_fee, max_reward: game.max_reward, settlement_rule: game.settlement_rule, status: 'playing', score: null, reward_requested: null, reward_points: null, expires_at: new Date(Date.now() + 1800000).toISOString(), created_at: new Date().toISOString() };
      if (!session.player_agent_id) { controls.userAvailable = (BigInt(controls.userAvailable) - BigInt(game.entry_fee)).toString(); controls.userReserved = (BigInt(controls.userReserved) + BigInt(game.entry_fee)).toString(); }
      starts.set(key, session);
      if (controls.loseStartResponse) { controls.loseStartResponse = false; return route.abort('failed'); }
      return respond(session, 201);
    }
    if (path === '/games/sessions' || path === `/games/${gameId}/sessions`) return respond({ items: session ? [session] : [] });
    if (path === `/games/sessions/${session?.id}`) return respond(session);
    if (path === `/games/sessions/${session?.id}/score`) {
      updateSession(session!.settlement_rule === 'starlight_slots_v1' ? { status: 'settled', score: '321', reward_requested: '3', reward_points: '3' } : { status: 'submitted', score: String(body.score), reward_requested: String(body.reward_requested) });
      return respond(session);
    }
    if (path === `/games/sessions/${session?.id}/refund`) { updateSession({ status: session!.settlement_rule === 'starlight_slots_v1' ? 'settled' : 'refunded', reward_points: session!.settlement_rule === 'starlight_slots_v1' ? '3' : null }); return respond(session); }
    return respond({ error: { code: 'NOT_FOUND' } }, 404);
  });
  await page.route(`**/game-content/${gameId}/**`, route => {
    const path = new URL(route.request().url()).pathname.split('/').at(-1);
    const headers = { 'access-control-allow-origin': '*', 'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'" };
    if (path === 'index.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', headers, body: '<!doctype html><title>游戏包</title><h1>加载中</h1><button id="finish">完成本局</button><script type="module" src="./main.js"></script>' });
    if (path === 'empty.wasm') return route.fulfill({ contentType: 'application/wasm', headers, body: Buffer.from([0,97,115,109,1,0,0,0]) });
    return route.fulfill({ contentType: 'text/javascript', headers, body: `const bytes=await fetch(new URL('./empty.wasm',import.meta.url)).then(r=>r.arrayBuffer());await WebAssembly.instantiate(bytes);document.querySelector('h1').textContent='WASM 已就绪';addEventListener('message',event=>{if(event.data.type==='init'){document.body.dataset.session=event.data.session_id??'';document.body.dataset.rule=event.data.settlement_rule}});document.querySelector('#finish').onclick=()=>parent.postMessage({protocol:'agentzero.game.v1',type:'submit',request_id:'finish-1',score:'120',reward_requested:'6'},'*');parent.postMessage({protocol:'agentzero.game.v1',type:'ready',request_id:'init-1'},'*');` });
  });
  return { game, writes, reads, controls, starts, updateSession };
}

for (const own of [false, true]) test(`${own ? '作者本人' : '玩家'}在网页选择钱包付费游玩，沙箱内 JS/WASM 运行并提交成绩，外部窗口消息无权提交`, async ({ page }) => {
  const { writes } = await fixture(page, own);
  await page.goto('/games');
  if (own) {
    await expect(page.getByText('管理奖池与结算', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '我的作品', exact: true }).click();
  }
  await page.getByRole('button', { name: '查看费用并游玩', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '星光试验场' });
  await expect(dialog.getByText('确认本局费用后开始游戏')).toBeVisible();
  expect(writes).toHaveLength(0);
  await expect(dialog.getByLabel('游戏积分账户')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: '确认支付 2 积分并开始' })).toBeEnabled();
  await dialog.getByLabel('游戏积分账户').selectOption(agentId);
  await dialog.getByRole('button', { name: '确认支付 2 积分并开始' }).click();
  await expect(dialog.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  expect(writes.filter(write => write.path === `/games/${gameId}/sessions`)).toMatchObject([{ body: { agent_id: agentId, game_version: '1' } }]);
  const frame = dialog.locator('iframe').contentFrame();
  const originalFrame = await dialog.locator('iframe').elementHandle();
  await expect(frame.getByRole('heading', { name: 'WASM 已就绪' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /再来一局/ })).toHaveCount(0);
  await page.evaluate(() => window.postMessage({ protocol: 'agentzero.game.v1', type: 'submit', request_id: 'forged', score: '900', reward_requested: '10' }, '*'));
  await expect.poll(() => writes.filter(write => write.path.endsWith('/score')).length).toBe(0);
  await frame.getByRole('button', { name: '完成本局' }).click();
  await expect(dialog.getByRole('status')).toContainText('等待发布者结算');
  await expect(dialog.getByRole('button', { name: /再来一局/ })).toHaveCount(0);
  await expect(frame.getByRole('heading', { name: 'WASM 已就绪' })).toBeVisible();
  expect(await originalFrame!.evaluate(element => element.isConnected)).toBe(true);
  expect(writes.find(write => write.path.endsWith('/score'))).toMatchObject({ body: { score: '120', reward_requested: '6' }, key: `game-result:${sessionId}` });
  expect(writes.filter(write => write.path.endsWith('/settle'))).toHaveLength(0);
  await frame.getByRole('button', { name: '完成本局' }).click();
  expect(writes.filter(write => write.path.endsWith('/score'))).toHaveLength(1);
  await page.screenshot({ path: `.local/game-session${own ? '-author' : ''}.png`, fullPage: true });
  await dialog.getByRole('button', { name: '关闭游戏' }).click();
  await page.getByRole('button', { name: '我的对局', exact: true }).click();
  await expect(page.getByText('分数 120 · 申请奖励 6 · 实际奖励 待结算')).toBeVisible();
  expect(writes.filter(write => write.path === `/games/${gameId}/sessions`)).toHaveLength(1);
});

for (const agents of ['empty', 'error'] as const) test(`个人钱包默认可直接玩游戏，Agent列表${agents === 'empty' ? '为空' : '失败'}不影响支付`, async ({ page }) => {
  const { controls, writes, reads } = await fixture(page);
  controls.agents = agents;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/games');
  await page.getByRole('button', { name: '查看费用并游玩', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '星光试验场' });
  await expect(dialog.getByLabel('游戏积分账户')).toHaveValue('');
  await expect(dialog.getByRole('option', { name: '我的钱包', exact: true })).toHaveCount(1);
  await expect(dialog.getByText('我的钱包可用 1,000 积分', { exact: true })).toBeVisible();
  await expect(dialog.getByText('所选 Agent 需开启资产交易权限并有足够额度。', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '确认支付 2 积分并开始' })).toBeEnabled();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  if (agents === 'empty') await page.screenshot({ path: '.local/user-game-wallet-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: '确认支付 2 积分并开始' }).click();
  await expect(dialog.locator('iframe').contentFrame().getByRole('heading', { name: 'WASM 已就绪' })).toBeVisible();
  expect(writes.filter(write => write.path === `/games/${gameId}/sessions`)).toMatchObject([{ body: { game_version: '1' } }]);
  expect(writes.find(write => write.path === `/games/${gameId}/sessions`)!.body).not.toHaveProperty('agent_id');
  await expect.poll(() => reads.filter(path => path === '/wallet').length).toBeGreaterThan(1);
  await dialog.getByRole('button', { name: '关闭游戏' }).click();
  await page.getByRole('link', { name: '钱包', exact: true }).click();
  await expect(page.getByTestId('user-available-balance')).toHaveText('998');
  await expect(page.getByTestId('user-reserved-balance')).toHaveText('2');
  await expect(page.getByRole('region', { name: '个人钱包流水' })).toContainText('可用 −2');
  await expect(page.getByRole('region', { name: '个人钱包流水' })).toContainText('冻结 +2');
});

test('个人钱包开局响应丢失后原键重试，恢复对局和超时退款沿用个人钱包', async ({ page }) => {
  const { controls, writes, starts, updateSession } = await fixture(page);
  controls.agents = 'empty'; controls.loseStartResponse = true;
  await page.clock.install();
  await page.goto('/games');
  await page.getByRole('button', { name: '查看费用并游玩', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '星光试验场' });
  await dialog.getByRole('button', { name: '确认支付 2 积分并开始' }).click();
  await expect(dialog.getByLabel('游戏积分账户')).toBeDisabled();
  await dialog.getByRole('button', { name: '核对并重试原操作' }).click();
  await expect(dialog.locator('iframe').contentFrame().getByRole('heading', { name: 'WASM 已就绪' })).toBeVisible();
  const attempts = writes.filter(write => write.path === `/games/${gameId}/sessions`);
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(starts.size).toBe(1);
  await dialog.getByRole('button', { name: '关闭游戏' }).click();
  await page.getByRole('button', { name: '我的对局', exact: true }).click();
  await page.getByRole('button', { name: '恢复对局', exact: true }).click();
  await dialog.getByText('本局费用与结算说明', { exact: true }).click();
  await expect(dialog.getByText('支付来源：我的钱包', { exact: true })).toBeVisible();
  expect(starts.size).toBe(1);
  updateSession({ expires_at: new Date(Date.now() - 1000).toISOString() });
  await page.clock.fastForward(5000);
  await dialog.getByRole('button', { name: '领取超时退款', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('本局费用 2 积分已退回钱包。');
  await expect(dialog.getByText('沿用本局个人钱包', { exact: true })).toBeVisible();
  expect(controls.userAvailable).toBe('1000'); expect(controls.userReserved).toBe('0');
  await dialog.getByRole('button', { name: '再来一局 · 2 积分', exact: true }).click();
  await expect(dialog.locator('iframe').contentFrame().locator('body')).toHaveAttribute('data-session', '41000000-0000-4000-8000-000000000002');
  expect(writes.filter(write => write.path === `/games/${gameId}/sessions`).every(write => !('agent_id' in write.body))).toBe(true);
  expect(starts.size).toBe(2);
});

test('个人钱包余额不足时不能开局，切换Agent后按其余额和权限提示支付', async ({ page }) => {
  const { game, controls, writes } = await fixture(page);
  game.entry_fee = '9007199254740993'; controls.userAvailable = '9007199254740992'; controls.agentAvailable = '9007199254740993';
  await page.goto('/games');
  await page.getByRole('button', { name: '查看费用并游玩', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '星光试验场' });
  const pay = dialog.getByRole('button', { name: '确认支付 9,007,199,254,740,993 积分并开始' });
  await expect(dialog.getByText('我的钱包可用 9,007,199,254,740,992 积分', { exact: true })).toBeVisible();
  await expect(pay).toBeDisabled();
  await expect(dialog.getByText('所选钱包可用积分不足，请补充积分或选择其他钱包。', { exact: true })).toBeVisible();
  await dialog.getByLabel('游戏积分账户').selectOption(agentId);
  await expect(dialog.getByText('所选 Agent 需开启资产交易权限并有足够额度。', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Agent 钱包可用 9,007,199,254,740,993 积分', { exact: true })).toBeVisible();
  await expect(pay).toBeEnabled();
  await pay.click();
  expect(writes.find(write => write.path === `/games/${gameId}/sessions`)!.body).toEqual({ game_version: '1', agent_id: agentId });
});

test('个人钱包自动结算奖励刷新余额，再来一局继续从个人钱包支付', async ({ page }) => {
  const { game, controls, writes, reads } = await fixture(page);
  controls.agents = 'empty'; Object.assign(game, { settlement_rule: 'starlight_slots_v1', entry_fee: '1', max_reward: '3' });
  await page.goto('/games');
  await page.getByRole('button', { name: '查看费用并游玩', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '星光试验场' });
  await dialog.getByRole('button', { name: '确认支付 1 积分并开始' }).click();
  await dialog.locator('iframe').contentFrame().getByRole('button', { name: '完成本局' }).click();
  await expect(dialog.getByRole('status')).toContainText('实际奖励：3 积分（已入账）');
  await expect.poll(() => reads.filter(path => path === '/wallet').length).toBeGreaterThan(2);
  expect(controls.userAvailable).toBe('1002'); expect(controls.userReserved).toBe('0');
  await expect(dialog.getByText('沿用本局个人钱包', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '再来一局 · 1 积分', exact: true }).click();
  await expect(dialog.locator('iframe').contentFrame().locator('body')).toHaveAttribute('data-session', '41000000-0000-4000-8000-000000000002');
  expect(writes.filter(write => write.path === `/games/${gameId}/sessions`).map(write => write.body)).toEqual([{ game_version: '1' }, { game_version: '1' }]);
});

test('免费预览可原生全屏与退出，Esc 保留游戏，关闭仅清理自己的全屏', async ({ page }) => {
  const { game, writes } = await fixture(page, true, true);
  game.accepting_players = false;
  await page.goto('/world');
  await page.getByRole('region', { name: '附近游戏机' }).getByRole('button', { name: '放大免费预览' }).click();
  const dialog = page.getByRole('dialog', { name: game.name });
  await expect(dialog.getByRole('status')).toContainText('免费预览');
  await expect(dialog.getByRole('button', { name: '查看费用并游玩', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '全屏游玩', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('role'))).toBe('dialog');
  await expect(dialog.getByRole('status')).toBeVisible();
  await dialog.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await dialog.getByRole('button', { name: '全屏游玩', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('iframe').contentFrame().getByRole('heading', { name: 'WASM 已就绪' })).toBeVisible();
  await dialog.getByRole('button', { name: '全屏游玩', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await dialog.getByRole('button', { name: '关闭游戏' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await page.getByRole('region', { name: '附近游戏机' }).getByRole('button', { name: '放大免费预览' }).click();
  await page.evaluate(() => document.body.requestFullscreen());
  await dialog.getByRole('button', { name: '关闭游戏' }).click();
  expect(await page.evaluate(() => document.fullscreenElement === document.body)).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  expect(writes).toHaveLength(0);
});

for (const outcome of ['settled', 'refunded'] as const) test(`轮询${outcome === 'settled' ? '结算入账' : '退款'}保留原游戏画面，可在原窗口确认再开一局`, async ({ page }) => {
  const { writes, reads, updateSession } = await fixture(page);
  await page.clock.install();
  const popups: string[] = [];
  page.on('dialog', async popup => { popups.push(popup.type()); await popup.dismiss(); });
  await page.goto('/games');
  await page.getByRole('button', { name: '查看费用并游玩', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '星光试验场' });
  await dialog.getByLabel('游戏积分账户').selectOption(agentId);
  await dialog.getByRole('button', { name: '确认支付 2 积分并开始' }).click();
  const originalFrame = await dialog.locator('iframe').elementHandle(), frame = dialog.locator('iframe').contentFrame();
  await frame.getByRole('button', { name: '完成本局' }).click();
  await expect(dialog.getByRole('status')).toContainText('等待发布者结算');
  updateSession({ status: outcome, reward_points: outcome === 'settled' ? '6' : null });
  await page.clock.fastForward(5000);
  await expect(dialog.getByRole('status')).toContainText(outcome === 'settled' ? '实际奖励：6 积分（已入账）' : '本局费用 2 积分已退回钱包。', { timeout: 10000 });
  await expect(dialog.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  expect(await originalFrame!.evaluate(element => element.isConnected)).toBe(true);
  await expect(frame.getByRole('heading', { name: 'WASM 已就绪' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(popups).toHaveLength(0);
  const sessionReads = reads.filter(path => path === `/games/sessions/${sessionId}`).length;
  await page.clock.fastForward(15000);
  expect(reads.filter(path => path === `/games/sessions/${sessionId}`)).toHaveLength(sessionReads);
  await dialog.getByRole('button', { name: '再来一局 · 2 积分', exact: true }).click();
  await expect(dialog.locator('iframe').contentFrame().locator('body')).toHaveAttribute('data-session', '41000000-0000-4000-8000-000000000002');
  await expect(dialog.getByRole('status')).toContainText('游戏中');
  await dialog.getByRole('button', { name: '关闭游戏' }).click();
  await expect(dialog).not.toBeVisible();
  expect(writes.filter(write => write.path === `/games/${gameId}/sessions`)).toHaveLength(2);
  expect(writes.filter(write => write.path.endsWith('/score'))).toHaveLength(1);
  expect(writes.filter(write => write.path.endsWith('/settle') || write.path.endsWith('/refund'))).toHaveLength(0);
});

test('老虎机服务端直接结算后在原全屏游戏机连续开局，连点仅创建一局并沿用账户', async ({ page }) => {
  const { game, writes, controls, starts } = await fixture(page, true, true);
  Object.assign(game, { settlement_rule: 'starlight_slots_v1', entry_fee: '1', max_reward: '3' });
  await page.goto('/world');
  await page.getByRole('region', { name: '附近游戏机' }).getByRole('button', { name: '查看费用并游玩', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: game.name }), player = await dialog.elementHandle();
  await expect(dialog.getByText(/开局后即使未提交，到期仍按本局规则结算/)).toBeVisible();
  await dialog.getByLabel('游戏积分账户').selectOption(agentId);
  await dialog.getByRole('button', { name: '确认支付 1 积分并开始' }).click();
  const oldFrame = await dialog.locator('iframe').elementHandle();
  await expect(dialog.locator('iframe').contentFrame().locator('body')).toHaveAttribute('data-rule', 'starlight_slots_v1');
  await dialog.getByRole('button', { name: '全屏游玩', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('role'))).toBe('dialog');
  game.version = '2';
  await dialog.locator('iframe').contentFrame().getByRole('button', { name: '完成本局' }).click();
  await expect(dialog.getByRole('status')).toContainText('游戏分数：321');
  await expect(dialog.getByRole('status')).toContainText('实际奖励：3 积分（已入账）');
  expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(true);
  let releaseStart!: () => void;
  controls.waitForStart = new Promise(resolve => { releaseStart = resolve; });
  const next = dialog.getByRole('button', { name: '再来一局 · 1 积分', exact: true });
  await expect(next).toBeEnabled();
  await expect(dialog.getByText('下一局：平台自动结算', { exact: true })).toBeVisible();
  await next.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(dialog.getByRole('button', { name: '正在开局…', exact: true })).toBeDisabled();
  await expect.poll(() => writes.filter(write => write.path === `/games/${gameId}/sessions`).length).toBe(2);
  releaseStart();
  await expect(dialog.locator('iframe').contentFrame().locator('body')).toHaveAttribute('data-session', '41000000-0000-4000-8000-000000000002');
  await expect(dialog.getByRole('status')).toContainText('游戏中');
  expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(false);
  expect(await player!.evaluate(element => element.isConnected && document.fullscreenElement === element)).toBe(true);
  expect(starts.size).toBe(2);
  const openings = writes.filter(write => write.path === `/games/${gameId}/sessions`);
  expect(openings[1].body).toEqual({ agent_id: agentId, game_version: '2' });
  expect(openings[1].key).not.toBe(openings[0].key);
  await dialog.getByRole('button', { name: '关闭游戏' }).click();
  expect(writes.filter(write => write.path === `/games/${gameId}/sessions`)).toHaveLength(2);
});

test('下一局余额或奖池不足原地提示，奖池恢复可继续，丢失开局响应按同一编号重试', async ({ page }) => {
  const { game, writes, controls, starts } = await fixture(page);
  Object.assign(game, { settlement_rule: 'starlight_slots_v1', entry_fee: '1', max_reward: '3' });
  await page.clock.install();
  await page.goto('/games');
  await page.getByRole('button', { name: '查看费用并游玩', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: game.name });
  await dialog.getByLabel('游戏积分账户').selectOption(agentId);
  await dialog.getByRole('button', { name: '确认支付 1 积分并开始' }).click();
  const oldFrame = await dialog.locator('iframe').elementHandle();
  await dialog.locator('iframe').contentFrame().getByRole('button', { name: '完成本局' }).click();
  const next = dialog.getByRole('button', { name: '再来一局 · 1 积分', exact: true });
  for (const [code, message] of [['INSUFFICIENT_FUNDS', '可用积分不足。'], ['GAME_POOL_LOW', '可用奖池低于开放门槛，发布者补足后自动恢复。']]) {
    controls.startError = code;
    await expect(next).toBeEnabled();
    await next.click();
    await expect(dialog.getByText(message, { exact: true })).toBeVisible();
    expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(true);
    await expect(dialog.getByRole('status')).toContainText('已结算');
    expect(starts.size).toBe(1);
  }
  game.accepting_players = false;
  await page.clock.fastForward(10000);
  await expect(next).toBeDisabled();
  await expect(dialog.getByText(/沿用本局 Agent 积分账户 · 奖池不足/)).toBeVisible();
  game.accepting_players = true;
  await page.clock.fastForward(10000);
  await expect(next).toBeEnabled();
  controls.loseStartResponse = true;
  await next.click();
  await expect(dialog.getByRole('button', { name: '核对并重试原操作' })).toBeVisible();
  await expect(next).toBeDisabled();
  expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(true);
  const lost = writes.filter(write => write.path === `/games/${gameId}/sessions`).at(-1)!;
  await dialog.getByRole('button', { name: '核对并重试原操作' }).click();
  await expect(dialog.locator('iframe').contentFrame().locator('body')).toHaveAttribute('data-session', '41000000-0000-4000-8000-000000000002');
  expect(writes.filter(write => write.path === `/games/${gameId}/sessions`).at(-1)!.key).toBe(lost.key);
  expect(starts.size).toBe(2);
});

test('自动规则局到期显示结算而非退款，按服务端结果原地恢复下一局入口', async ({ page }) => {
  const { game, writes, updateSession } = await fixture(page);
  Object.assign(game, { settlement_rule: 'starlight_slots_v1', entry_fee: '1', max_reward: '3' });
  await page.clock.install();
  await page.goto('/games');
  await page.getByRole('button', { name: '查看费用并游玩', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: game.name });
  await dialog.getByLabel('游戏积分账户').selectOption(agentId);
  await dialog.getByRole('button', { name: '确认支付 1 积分并开始' }).click();
  await expect(dialog.locator('iframe').contentFrame().locator('body')).toHaveAttribute('data-rule', 'starlight_slots_v1');
  updateSession({ expires_at: new Date(Date.now() - 1000).toISOString() });
  await page.clock.fastForward(5000);
  await expect(dialog.getByRole('button', { name: /退款/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: '完成超时结算' }).click();
  await expect(dialog.getByRole('status')).toContainText('实际奖励：3 积分（已入账）');
  await expect(dialog.getByRole('button', { name: '再来一局 · 1 积分', exact: true })).toBeEnabled();
  expect(writes.filter(write => write.path.endsWith('/score'))).toHaveLength(0);
});

for (const mode of ['unsupported', 'rejected'] as const) test(`手机${mode === 'unsupported' ? '不支持' : '拒绝'}原生全屏时使用视口布局，免费预览不创建对局`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(value => {
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: value === 'unsupported' ? undefined : () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) });
  }, mode);
  const { game, writes } = await fixture(page);
  game.accepting_players = false;
  await page.goto('/games');
  await page.getByRole('button', { name: '免费预览', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: game.name });
  const frame = dialog.locator('iframe').contentFrame();
  await expect(frame.getByRole('heading', { name: 'WASM 已就绪' })).toBeVisible();
  await dialog.getByRole('button', { name: '全屏游玩', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '退出全屏', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.fullscreenElement)).toBe(null);
  await expect.poll(async () => Math.round((await dialog.boundingBox())?.width ?? 0)).toBe(390);
  await expect.poll(async () => Math.round((await dialog.boundingBox())?.height ?? 0)).toBe(844);
  const fitsViewport = await dialog.evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight);
  expect(fitsViewport).toBe(true);
  await expect(dialog.getByRole('status')).toBeInViewport();
  await expect(dialog.getByRole('button', { name: '退出全屏', exact: true })).toBeInViewport();
  await frame.getByRole('button', { name: '完成本局' }).click();
  await dialog.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '全屏游玩', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '全屏游玩', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: '全屏游玩', exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '关闭游戏' }).click();
  expect(writes).toHaveLength(0);
});

test('发布者存取奖池并配置开放门槛，低于门槛时显示停售', async ({ page }) => {
  const { writes } = await fixture(page, true);
  await page.goto('/games');
  await page.getByText('管理奖池与结算', { exact: true }).click();
  await page.getByLabel('奖池操作').selectOption('withdraw');
  await page.getByLabel('操作积分', { exact: true }).fill('15');
  await page.getByRole('button', { name: '提取可用积分' }).click();
  await expect(page.getByText('奖池不足 · 暂停接待', { exact: true })).toBeVisible();
  await expect(page.getByText('可提取 15', { exact: true })).toBeVisible();
  await page.getByLabel('奖池操作').selectOption('fund');
  await page.getByLabel('操作积分', { exact: true }).fill('10');
  await page.getByRole('button', { name: '存入奖池' }).click();
  await expect(page.getByText('营业中', { exact: true })).toBeVisible();
  await page.getByLabel('开放门槛', { exact: true }).fill('22');
  await page.getByRole('button', { name: '保存规则与门槛' }).click();
  await expect.poll(() => writes.find(write => write.path === `/games/${gameId}`)?.body.minimum_pool).toBe('22');
});

for (const rule of ['manual', 'starlight_slots_v1'] as const) test(`玩家上传 HTML 游戏并选择${rule === 'manual' ? '发布者核验' : '平台自动'}结算`, async ({ page }) => {
  const { writes } = await fixture(page, true);
  await page.goto('/games');
  await page.getByRole('button', { name: '发布游戏', exact: true }).click();
  const editor = page.getByRole('region', { name: '发布游戏' });
  await editor.getByLabel('游戏积分账户').selectOption(agentId);
  await editor.getByLabel('游戏名称', { exact: true }).fill('自制小游戏');
  await editor.getByRole('combobox', { name: '结算方式', exact: true }).selectOption(rule);
  if (rule === 'starlight_slots_v1') await expect(editor.getByText(/每局固定 1 积分，最高奖励 3 积分/)).toBeVisible();
  await editor.getByLabel('游戏来源').selectOption('bundle');
  await editor.getByLabel('上传单个 HTML').setInputFiles({ name: 'index.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><h1>自制游戏</h1>') });
  await expect(editor.getByText('1 个文件已读取')).toBeVisible();
  await editor.getByRole('button', { name: '创建游戏', exact: true }).click();
  await expect.poll(() => writes.some(write => write.path === '/games')).toBe(true);
  const body = writes.find(write => write.path === '/games')!.body;
  expect(body).toMatchObject({ agent_id: agentId, name: '自制小游戏', entry_fee: '1', max_reward: rule === 'starlight_slots_v1' ? '3' : '10', minimum_pool: '10', settlement_rule: rule, source: { type: 'bundle', entry: 'index.html', files: [{ path: 'index.html', mime: 'text/html', content: Buffer.from('<!doctype html><h1>自制游戏</h1>').toString('base64') }] } });
});

test('作者可为匹配费用的作品启用服务端自动结算规则', async ({ page }) => {
  const { game, writes } = await fixture(page, true);
  Object.assign(game, { entry_fee: '1', max_reward: '3' });
  await page.goto('/games');
  await page.getByText('管理奖池与结算', { exact: true }).click();
  await page.getByRole('combobox', { name: '结算方式', exact: true }).selectOption('starlight_slots_v1');
  await page.getByRole('button', { name: '保存规则与门槛' }).click();
  await expect.poll(() => writes.find(write => write.path === `/games/${gameId}`)?.body.settlement_rule).toBe('starlight_slots_v1');
  await page.getByRole('button', { name: '查看费用并游玩', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/服务端自动核验派奖/)).toBeVisible();
});

test('作者靠近游戏机显示可运行的免费浮空预览，亲自开局及关闭游戏保留场景', async ({ page }) => {
  const { writes } = await fixture(page, true, true);
  await page.goto('/world');
  const bubble = page.getByRole('region', { name: '附近游戏机', exact: true });
  await expect(bubble).toBeVisible();
  await expect(bubble.getByRole('button', { name: '设置游戏', exact: true })).toBeVisible();
  const preview = bubble.locator('iframe').contentFrame();
  await expect(preview.getByRole('heading', { name: 'WASM 已就绪' })).toBeVisible();
  await preview.getByRole('button', { name: '完成本局' }).click();
  expect(writes).toHaveLength(0);
  await page.screenshot({ path: '.local/game-machine-preview.png', fullPage: true });
  await bubble.getByRole('button', { name: '查看费用并游玩' }).click();
  const dialog = page.getByRole('dialog', { name: '星光试验场' });
  await dialog.getByLabel('游戏积分账户').selectOption(agentId);
  await dialog.getByRole('button', { name: '确认支付 2 积分并开始' }).click();
  await expect(dialog.locator('iframe').contentFrame().getByRole('heading', { name: 'WASM 已就绪' })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭游戏' }).click();
  await expect(bubble).toBeVisible();
  await expect(bubble.locator('iframe')).toBeVisible();
  expect(writes.filter(write => write.path.endsWith('/sessions'))).toHaveLength(1);
});
