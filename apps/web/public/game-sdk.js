/* AgentZero browser game bridge. No platform credentials enter the game frame. */
/* global window, CustomEvent, clearTimeout, setTimeout, crypto */
(() => {
  'use strict';
  const protocol = 'agentzero.game.v1', pending = new Map();
  let context = null, readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.protocol !== protocol) return;
    const message = event.data;
    if (message.type === 'init') {
      context = Object.freeze({ mode: message.mode, sessionId: message.session_id, entryFee: message.entry_fee, maxReward: message.max_reward,
        settlementRule: message.settlement_rule ?? 'manual' });
      readyResolve(context); window.dispatchEvent(new CustomEvent('agentzero:ready', { detail: context }));
    } else if (message.type === 'result') {
      const request = pending.get(message.request_id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.request_id);
      if (message.ok) request.resolve(message.session); else request.reject(new Error(message.error || 'SUBMIT_FAILED'));
    }
  });
  window.AgentZeroGame = Object.freeze({
    ready: () => ready,
    async submitScore(score, rewardRequested = '0') {
      await ready;
      const game = context;
      if (game.mode !== 'play' || !game.sessionId) throw new Error('PREVIEW_ONLY');
      const values = [String(score), String(rewardRequested)];
      if (values.some(value => !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)) throw new Error('INVALID_AMOUNT');
      if (BigInt(values[1]) > BigInt(game.maxReward)) throw new Error('REWARD_EXCEEDS_MAXIMUM');
      const request_id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(request_id); reject(new Error('RESULT_PENDING_CHECK_PARENT')); }, 20000);
        pending.set(request_id, { resolve, reject, timer });
        window.parent.postMessage({ protocol, type: 'submit', request_id, score: values[0], reward_requested: values[1] }, '*');
      });
    },
    get context() { return context; },
  });
  window.parent.postMessage({ protocol, type: 'ready', request_id: 'sdk-ready' }, '*');
})();
