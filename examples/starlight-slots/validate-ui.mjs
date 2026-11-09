/* global process, URL, window, console */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { calculateResult } from './rules.js';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.local/playwright');
const { chromium, expect } = await import('@playwright/test');
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = resolve(directory, '.validation');
await mkdir(output, { recursive: true });
const runtime = new Map([['index.html', 'text/html'], ['main.js', 'text/javascript'], ['rules.js', 'text/javascript'], ['style.css', 'text/css']]);
const sessionId = '41000000-0000-4000-8000-000000000023';
const harness = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0a111a;display:grid;place-items:center;min-height:100vh}iframe{border:0;width:520px;height:800px}</style><iframe title="星光机台" sandbox="allow-scripts" src="/index.html"></iframe><script>
const frame=document.querySelector('iframe'); window.messages=[];
window.config={protocol:'agentzero.game.v1',type:'init',mode:new URLSearchParams(location.search).get('mode')||'preview',session_id:'${sessionId}',entry_fee:'1',max_reward:'3'};
window.send=value=>frame.contentWindow.postMessage(value,'*');window.init=()=>window.send(window.config);
addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;window.messages.push(event.data);if(event.data.type==='ready')window.init();});
frame.addEventListener('load',()=>window.init());
</script>`;
const server = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1);
  if (name === 'host') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(harness); return; }
  if (!runtime.has(name)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': `${runtime.get(name)}; charset=utf-8`, 'access-control-allow-origin': '*',
    'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'" });
  response.end(await readFile(resolve(directory, name)));
});
await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = [], errors = [];
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/host?mode=preview`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('body')).toHaveAttribute('data-mode', 'preview');
  for (let count = 0; count < 3; count++) {
    await frame.locator('#spin').click(); await expect(frame.locator('body')).toHaveAttribute('data-state', 'revealed');
  }
  expect(await page.evaluate(() => window.messages.filter(message => message.type === 'submit').length)).toBe(0);
  checks.push('three preview rounds never submit points');
  await frame.locator('body').evaluate(body => body.ownerDocument.defaultView.postMessage({ protocol: 'agentzero.game.v1', type: 'init', mode: 'play', session_id: '41000000-0000-4000-8000-000000000023', entry_fee: '1', max_reward: '3' }, '*'));
  await expect(frame.locator('body')).toHaveAttribute('data-mode', 'preview'); checks.push('non-parent init ignored');
  await page.locator('iframe').screenshot({ path: resolve(output, 'desktop-preview.png') });
  await page.locator('iframe').evaluate(element => { element.style.width = '278px'; element.style.height = '175px'; });
  await expect(frame.locator('#spin')).toBeVisible();
  const compact = await frame.locator('body').evaluate(body => ({ width: body.scrollWidth, height: body.scrollHeight, innerWidth: body.ownerDocument.defaultView.innerWidth, innerHeight: body.ownerDocument.defaultView.innerHeight }));
  expect(compact.width).toBeLessThanOrEqual(compact.innerWidth); expect(compact.height).toBeLessThanOrEqual(compact.innerHeight);
  await page.locator('iframe').screenshot({ path: resolve(output, 'bubble-preview.png') }); checks.push('278 × 175 preview fits without scrolling');
  await page.goto(`${origin}/host?mode=play`);
  await expect(frame.locator('#mode')).toHaveText('正式对局');
  await frame.locator('#spin').click();
  await page.evaluate(() => { window.init(); window.init(); });
  await expect.poll(() => page.evaluate(() => window.messages.filter(message => message.type === 'submit').length)).toBe(1);
  const expected = await calculateResult(sessionId);
  const first = await page.evaluate(() => window.messages.find(message => message.type === 'submit'));
  expect(first).toEqual({ protocol: 'agentzero.game.v1', type: 'submit', request_id: `starlight:${sessionId}`, score: expected.score, reward_requested: expected.reward_requested });
  checks.push('formal triple matches independent verifier and submits once despite duplicate init');
  await page.evaluate(requestId => window.send({ protocol: 'agentzero.game.v1', type: 'result', request_id: requestId, ok: false, error: 'NETWORK_ERROR' }), first.request_id);
  await expect(frame.locator('body')).toHaveAttribute('data-state', 'failed');
  await page.evaluate(() => window.init()); await expect(frame.locator('body')).toHaveAttribute('data-state', 'failed');
  await frame.locator('#spin').click();
  await expect.poll(() => page.evaluate(() => window.messages.filter(message => message.type === 'submit').length)).toBe(2);
  expect(await page.evaluate(() => window.messages.filter(message => message.type === 'submit')[1])).toEqual(first);
  const accepted = { id: sessionId, status: 'submitted', score: expected.score, reward_requested: expected.reward_requested, reward_points: null };
  await page.evaluate(({ requestId, session }) => window.send({ protocol: 'agentzero.game.v1', type: 'result', request_id: requestId, ok: true, session: { ...session, id: 'wrong-session' } }), { requestId: first.request_id, session: accepted });
  await expect(frame.locator('body')).toHaveAttribute('data-state', 'submitting');
  await page.evaluate(({ requestId, session }) => window.send({ protocol: 'agentzero.game.v1', type: 'result', request_id: requestId, ok: true, session }), { requestId: first.request_id, session: accepted });
  await expect(frame.locator('body')).toHaveAttribute('data-state', 'submitted');
  await expect(frame.locator('#status')).toContainText('当前尚未发放奖励');
  await page.evaluate(() => { window.init(); window.send({ ...window.config, mode: 'preview', session_id: null }); });
  await expect(frame.locator('#spin')).toBeDisabled(); await expect(frame.locator('body')).toHaveAttribute('data-mode', 'play');
  checks.push('retry keeps identical request/result; wrong-session receipt ignored; confirmed result stays submitted');
  await page.locator('iframe').screenshot({ path: resolve(output, 'desktop-submitted.png') });
  const automaticId = '41000000-0000-4000-8000-000000000024';
  await page.evaluate(id => { window.config = { ...window.config, session_id: id, settlement_rule: 'starlight_slots_v1' }; window.init(); }, automaticId);
  await expect(frame.locator('#settlement-label')).toHaveText('服务端自动结算派奖');
  await expect(frame.locator('#status')).toContainText('到期结算');
  await frame.locator('#spin').click();
  await expect.poll(() => page.evaluate(() => window.messages.filter(message => message.type === 'submit').length)).toBe(3);
  const automaticResult = await calculateResult(automaticId);
  const settled = { id: automaticId, status: 'settled', score: automaticResult.score,
    reward_requested: automaticResult.reward_requested, reward_points: automaticResult.reward_requested };
  await page.evaluate(session => window.send({ protocol: 'agentzero.game.v1', type: 'result', request_id: `starlight:${session.id}`, ok: true, session }), settled);
  await expect(frame.locator('body')).toHaveAttribute('data-state', 'settled');
  await expect(frame.locator('#status')).toContainText('再来一局');
  await expect(frame.locator('#reward')).toHaveText(automaticResult.reward_requested);
  await expect(frame.locator('#reward-label')).toHaveText('实际积分');
  await expect(frame.locator('#spin')).toBeDisabled();
  checks.push('automatic settlement receipt shows actual reward and next-round guidance');
  const nextId = '41000000-0000-4000-8000-000000000025';
  await page.evaluate(id => { window.config = { ...window.config, session_id: id }; window.init(); }, nextId);
  await expect(frame.locator('body')).toHaveAttribute('data-state', 'ready');
  await expect(frame.locator('#spin')).toBeEnabled();
  await expect(frame.locator('#reward')).toHaveText('—');
  await page.evaluate(session => window.send({ protocol: 'agentzero.game.v1', type: 'result', request_id: `starlight:${session.id}`, ok: true, session }), settled);
  await expect(frame.locator('body')).toHaveAttribute('data-state', 'ready');
  await frame.locator('#spin').click();
  await expect.poll(() => page.evaluate(() => window.messages.filter(message => message.type === 'submit').length)).toBe(4);
  const nextResult = await calculateResult(nextId);
  expect(await page.evaluate(() => window.messages.filter(message => message.type === 'submit').at(-1))).toEqual({
    protocol: 'agentzero.game.v1', type: 'submit', request_id: `starlight:${nextId}`, score: nextResult.score, reward_requested: nextResult.reward_requested,
  });
  checks.push('next paid session resets once and rejects previous-round receipt');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('iframe').evaluate(element => { element.style.width = '390px'; element.style.height = '780px'; });
  const mobile = await frame.locator('body').evaluate(body => ({ width: body.scrollWidth, innerWidth: body.ownerDocument.defaultView.innerWidth }));
  expect(mobile.width).toBeLessThanOrEqual(mobile.innerWidth);
  await page.locator('iframe').screenshot({ path: resolve(output, 'mobile-submitted.png') }); checks.push('390 px mobile layout has no horizontal overflow');
  expect(errors).toEqual([]);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ ok: true, checks, console_errors: errors, local_only: true }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, output }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}
