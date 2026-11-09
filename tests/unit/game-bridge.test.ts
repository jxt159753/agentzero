import { describe, expect, it } from 'vitest';
import { GAME_PROTOCOL, gameMessage } from '../../apps/web/src/game-bridge.js';

describe('sandboxed game bridge', () => {
  const frame = {} as Window;
  const message = (data: unknown, source = frame) => ({ source, data } as MessageEvent);
  it('accepts messages only from the current game frame and validates bounded decimal amounts', () => {
    const data = { protocol: GAME_PROTOCOL, type: 'submit', request_id: 'finish-1', score: '9007199254740993', reward_requested: '2' };
    expect(gameMessage(message(data), frame)).toEqual(data);
    expect(gameMessage(message(data, {} as Window), frame)).toBeNull();
    expect(gameMessage(message(data), null)).toBeNull();
    for (const value of ['-1', '1.2', '1e3', '01', '9223372036854775808', 10, {}]) expect(gameMessage(message({ ...data, score: value }), frame)).toBeNull();
    expect(gameMessage(message({ ...data, reward_requested: '-1' }), frame)).toBeNull();
    expect(gameMessage(message({ ...data, request_id: 'x'.repeat(81) }), frame)).toBeNull();
    expect(gameMessage(message({ ...data, type: 'transfer' }), frame)).toBeNull();
  });
  it('handshakes without accepting unrelated postMessage protocols', () => {
    expect(gameMessage(message({ protocol: GAME_PROTOCOL, type: 'ready', request_id: 'init' }), frame)?.type).toBe('ready');
    expect(gameMessage(message({ protocol: 'other', type: 'ready', request_id: 'init' }), frame)).toBeNull();
    expect(gameMessage(message(null), frame)).toBeNull();
  });
});
