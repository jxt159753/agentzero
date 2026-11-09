import { createHash } from 'node:crypto';

/** Matches the published browser game's v1 algorithm; only the stored session ID is trusted. */
export function starlightSlotsResult(sessionId: string) {
  const digest = createHash('sha256').update(`agentzero-starlight-slots-v1:${sessionId}`, 'utf8').digest();
  const symbols = new Set([digest[0]! % 3, digest[1]! % 3, digest[2]! % 3]).size;
  return { score: symbols === 1 ? '100' : symbols === 2 ? '20' : '0', reward_points: symbols === 1 ? '3' : symbols === 2 ? '1' : '0' };
}
