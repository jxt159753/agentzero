/* global window, document, crypto, matchMedia, setTimeout, clearTimeout */
import { calculateResult, SYMBOLS } from './rules.js';

const PROTOCOL = 'agentzero.game.v1';
const embedded = window.parent !== window;
const sessions = new Map();
const elements = Object.fromEntries(['mode', 'machine-label', 'reels', 'result-caption', 'result-title', 'reward', 'reward-label',
  'spin', 'button-label', 'status', 'fee', 'settlement-label', 'session-label', 'digest-label'].map(id => [id, document.getElementById(id)]));
const reels = [...document.querySelectorAll('.reel')];
let current = null, hostOrigin = null;

const amount = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = () => ({ status: 'ready', result: null, error: '', timer: null });
const send = message => window.parent.postMessage({ protocol: PROTOCOL, ...message }, hostOrigin && hostOrigin !== 'null' ? hostOrigin : '*');

function paintReels(result) {
  if (!result) return;
  result.reels.forEach((symbolIndex, index) => {
    const symbol = SYMBOLS[symbolIndex], reel = reels[index];
    reel.dataset.symbol = symbol.id;
    reel.querySelector('.glyph').textContent = symbol.glyph;
    reel.querySelector('.symbol-name').textContent = symbol.name;
  });
  elements.reels.setAttribute('aria-label', result.reels.map(index => SYMBOLS[index].name).join('、'));
}

function render() {
  if (!current) return;
  const { mode, sessionId, entryFee, state, automatic } = current;
  const preview = mode === 'preview', spinning = state.status === 'spinning';
  const result = spinning ? null : state.result;
  document.body.dataset.mode = mode;
  document.body.dataset.state = state.status;
  elements.mode.dataset.mode = mode;
  elements.mode.textContent = preview ? '免费试玩' : '正式对局';
  elements['machine-label'].textContent = preview ? 'FREE PLAY · 演示模式' : 'SESSION READY · 本局已开局';
  elements.fee.textContent = preview ? '试玩不扣积分' : `本局费用 ${entryFee} 积分`;
  elements['settlement-label'].textContent = automatic ? '服务端自动结算派奖' : '作者核验后结算';
  elements['session-label'].textContent = preview ? '免费试玩 · 不会提交成绩或奖励' : sessionId;
  elements['digest-label'].textContent = state.result?.digest ?? '尚未转动';
  elements.reels.classList.toggle('spinning', spinning);
  elements.reels.classList.toggle('win', Boolean(result && result.outcome !== 'different'));
  elements.reels.setAttribute('aria-busy', String(spinning));
  paintReels(result);
  elements['result-caption'].textContent = state.status === 'submitted' ? automatic ? '已提交 · 等待平台结算' : '已提交 · 等待作者核验'
    : state.status === 'settled' ? '平台已结算' : state.status === 'refunded' ? '平台已退款'
      : result ? `${preview ? '演示' : '本局'}结果 · ${result.score} 分` : preview ? '每一次试玩，都免费' : '一局一次 · 结果可独立核验';
  elements['result-title'].textContent = spinning ? '让星光再转一会儿…' : result
    ? { triple: '三枚同耀 · 星光满格', pair: '两枚相逢 · 小小幸运', different: '三色星光 · 各自闪耀' }[result.outcome]
    : '下一道星光，等你转动';
  elements.reward.textContent = state.status === 'settled' ? state.rewardPoints : result ? result.reward_requested : '—';
  elements['reward-label'].textContent = state.status === 'settled' ? '实际积分' : preview ? '演示积分' : '申请积分';

  const descriptions = {
    ready: preview ? '免费体验转动效果，不扣积分，也不发放奖励。' : automatic
      ? '转动后由平台自动核验、结算和派奖；中途关闭也会到期结算。'
      : '费用已由平台处理。转动后自动提交本局结果，等待作者核验。',
    spinning: preview ? '演示转动中，不会提交任何积分。' : '正在展开本局结果；再次初始化不会重开一局。',
    revealed: preview ? '这是免费演示结果。想再试一次，随时转动。' : '结果已保留，点击下方按钮提交同一局结果。',
    submitting: '正在提交成绩和奖励申请，请稍候…',
    submitted: automatic ? '结果已提交，等待平台自动结算。当前尚未确认到账。' : '结果已提交，等待作者核验后结算。当前尚未发放奖励。',
    settled: `平台已结算，实际奖励 ${state.rewardPoints ?? '0'} 积分。点击游戏窗口下方“再来一局”即可继续。`,
    refunded: '本局已由平台退款，可在游戏窗口下方开始下一局。',
    failed: state.error || '暂未收到回执，结果已保留。重试只会提交同一局结果。',
    closed: state.error || '本局已关闭，请返回游戏工坊查看记录。',
    unavailable: '机台的最高奖励配置低于 3 积分，请联系发布者。',
  };
  elements.status.textContent = descriptions[state.status];
  elements.status.title = descriptions[state.status];
  elements.status.dataset.error = String(['failed', 'closed', 'unavailable'].includes(state.status));
  elements['button-label'].textContent = state.status === 'spinning' ? '星光转动中…'
    : state.status === 'submitting' ? '正在提交结果…' : state.status === 'submitted' ? '已提交 · 等待结算'
      : state.status === 'settled' ? '本局已结算' : state.status === 'refunded' ? '本局已退款'
        : state.status === 'closed' ? '本局已关闭' : state.status === 'unavailable' ? '机台配置待更新'
          : state.status === 'failed' ? '重试提交本局结果' : state.status === 'revealed' && !preview ? '提交本局结果'
            : preview && result ? '再免费试玩一次' : preview ? '免费转动星光' : '转动本局星光';
  elements.spin.disabled = !['ready', 'revealed', 'failed'].includes(state.status);
}

function initialize(message) {
  if (!['preview', 'play'].includes(message.mode) || !amount(message.entry_fee) || !amount(message.max_reward)) return;
  if (message.mode === 'play' && !uuid(message.session_id)) return;
  // A repeated preview init cannot reset a paid session, or its in-flight submission.
  if (current?.mode === 'play' && message.mode === 'preview') return;
  const key = message.mode === 'play' ? message.session_id : 'preview';
  if (current?.key === key) { render(); return; }
  const state = message.mode === 'play' ? sessions.get(key) ?? record() : record();
  if (message.mode === 'play') {
    sessions.set(key, state);
    if (BigInt(message.max_reward) < 3n && state.status === 'ready') state.status = 'unavailable';
  }
  current = { key, mode: message.mode, sessionId: message.session_id ?? null, entryFee: message.entry_fee, state,
    automatic: message.settlement_rule === 'starlight_slots_v1' };
  render();
}

function submit(context) {
  const state = context.state;
  if (!embedded || context !== current || context.mode !== 'play' || !state.result
    || !['revealed', 'failed'].includes(state.status)) return;
  state.status = 'submitting'; state.error = ''; render();
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    if (state.status !== 'submitting') return;
    state.status = 'failed';
    state.error = '暂未收到回执，结果已保留。重试同一局；仍未确认时，可使用游戏窗口的提交重试按钮。';
    if (current === context) render();
  }, 8000);
  send({ type: 'submit', request_id: `starlight:${context.sessionId}`, score: state.result.score, reward_requested: state.result.reward_requested });
}

async function spin() {
  const context = current;
  if (!context) return;
  const state = context.state;
  if (context.mode === 'play' && ['revealed', 'failed'].includes(state.status)) { submit(context); return; }
  if (state.status !== 'ready' && !(context.mode === 'preview' && state.status === 'revealed')) return;
  state.status = 'spinning'; state.error = ''; render();
  try {
    const seed = context.mode === 'play' ? context.sessionId : crypto.randomUUID();
    state.result = await calculateResult(seed);
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 120 : 1150;
    await new Promise(resolve => setTimeout(resolve, duration));
    state.status = 'revealed';
    if (current !== context) return;
    render();
    if (context.mode === 'play') submit(context);
  } catch {
    state.status = 'ready';
    if (current === context) {
      render(); elements.status.textContent = '本局计算未完成，请再试一次；对局编号和结果规则保持不变。';
      elements.status.dataset.error = 'true';
    }
  }
}

window.addEventListener('message', event => {
  if (!embedded || event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
  const message = event.data;
  if (message.protocol !== PROTOCOL || hostOrigin !== null && event.origin !== hostOrigin) return;
  if (message.type === 'init') {
    if (hostOrigin === null) hostOrigin = event.origin;
    initialize(message); return;
  }
  const context = current;
  if (message.type !== 'result' || context?.mode !== 'play' || !context.state.result
    || message.request_id !== `starlight:${context.sessionId}` || !['submitting', 'failed'].includes(context.state.status)) return;
  const state = context.state;
  if (message.ok === true) {
    const session = message.session;
    if (!session || session.id !== context.sessionId || !['submitted', 'settled', 'refunded'].includes(session.status)
      || session.score !== state.result.score || session.reward_requested !== state.result.reward_requested) return;
    if (session.status === 'settled' && !amount(session.reward_points)) return;
    clearTimeout(state.timer); state.status = session.status; state.rewardPoints = session.reward_points; state.error = '';
  } else if (message.ok === false && typeof message.error === 'string') {
    clearTimeout(state.timer);
    state.status = ['SESSION_CLOSED', 'PREVIEW_ONLY'].includes(message.error) ? 'closed' : 'failed';
    state.error = state.status === 'closed' ? '本局已关闭，请返回游戏工坊查看记录。'
      : '本次提交尚未确认，结果已保留。可重试同一局，或使用游戏窗口中的提交重试按钮。';
  } else return;
  render();
});

elements.spin.addEventListener('click', () => { void spin(); });
if (embedded) send({ type: 'ready', request_id: 'starlight-ready-v1' });
else initialize({ mode: 'preview', session_id: null, entry_fee: '1', max_reward: '3' });
