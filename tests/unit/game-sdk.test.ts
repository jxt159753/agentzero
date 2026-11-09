import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('uses the latest round context after another init and resolves an automatic settlement receipt', async () => {
  const sent: Record<string, unknown>[] = [];
  let receive!: (event: { source: unknown; data: Record<string, unknown> }) => void;
  const parent = { postMessage: (message: Record<string, unknown>) => sent.push(message) };
  const browser = {
    parent,
    addEventListener: (_type: string, handler: typeof receive) => { receive = handler; },
    dispatchEvent: () => {},
    AgentZeroGame: undefined as unknown as {
      ready: () => Promise<{ sessionId: string; settlementRule: string }>;
      submitScore: (score: string, reward: string) => Promise<Record<string, unknown>>;
      context: { sessionId: string; settlementRule: string };
    },
  };
  runInNewContext(readFileSync('apps/web/public/game-sdk.js', 'utf8'), {
    window: browser, CustomEvent, crypto: { randomUUID: () => 'submit-next-round' }, setTimeout, clearTimeout,
  });
  const send = (message: Record<string, unknown>) => receive({ source: parent, data: { protocol: 'agentzero.game.v1', ...message } });
  send({ type: 'init', mode: 'preview', session_id: null, entry_fee: '1', max_reward: '3' });
  expect((await browser.AgentZeroGame.ready()).settlementRule).toBe('manual');
  send({ type: 'init', mode: 'play', session_id: 'next-round', entry_fee: '1', max_reward: '3', settlement_rule: 'starlight_slots_v1' });
  expect(browser.AgentZeroGame.context.sessionId).toBe('next-round');
  expect(browser.AgentZeroGame.context.settlementRule).toBe('starlight_slots_v1');
  const pending = browser.AgentZeroGame.submitScore('20', '1');
  await Promise.resolve();
  expect(sent.at(-1)).toMatchObject({ type: 'submit', request_id: 'submit-next-round', score: '20', reward_requested: '1' });
  send({ type: 'result', request_id: 'submit-next-round', ok: true, session: { id: 'next-round', status: 'settled', reward_points: '1' } });
  expect(await pending).toMatchObject({ id: 'next-round', status: 'settled', reward_points: '1' });
});
