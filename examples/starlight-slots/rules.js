/* global TextEncoder */
export const RULE_VERSION = 'agentzero-starlight-slots-v1';
export const SYMBOLS = Object.freeze([
  Object.freeze({ id: 'star', glyph: '✦', name: '星光' }),
  Object.freeze({ id: 'moon', glyph: '☾', name: '月亮' }),
  Object.freeze({ id: 'gem', glyph: '◆', name: '宝石' }),
]);

/** The published v1 rule is deliberately byte-for-byte reproducible by an author. */
export function resultFromDigest(digest) {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new TypeError('Expected a SHA-256 digest.');
  const reels = Array.from(digest.slice(0, 3), byte => byte % SYMBOLS.length);
  const matches = new Set(reels).size;
  const score = matches === 1 ? '100' : matches === 2 ? '20' : '0';
  const reward_requested = matches === 1 ? '3' : matches === 2 ? '1' : '0';
  return { rule_version: RULE_VERSION, reels, symbols: reels.map(index => SYMBOLS[index].id), score, reward_requested,
    outcome: matches === 1 ? 'triple' : matches === 2 ? 'pair' : 'different',
    digest: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') };
}

export async function calculateResult(sessionId, subtle = globalThis.crypto.subtle) {
  if (typeof sessionId !== 'string' || !sessionId.length) throw new TypeError('A session ID is required.');
  const bytes = new TextEncoder().encode(`${RULE_VERSION}:${sessionId}`);
  return resultFromDigest(new Uint8Array(await subtle.digest('SHA-256', bytes)));
}
