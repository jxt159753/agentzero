import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { calculateResult, resultFromDigest } from './rules.js';

test('published session vector yields the independently calculated pair', async () => {
  const result = await calculateResult('41000000-0000-4000-8000-000000000001');
  assert.equal(result.digest, '34e536b54dc92f1f237f7e1a05f29e8bf12cdd6c55396f823577892d8410c670');
  assert.deepEqual(result.reels, [1, 1, 0]);
  assert.equal(result.score, '20'); assert.equal(result.reward_requested, '1');
});
test('published triple vector awards three and remains stable across calls', async () => {
  const id = '41000000-0000-4000-8000-000000000023', result = await calculateResult(id);
  assert.equal(result.digest, '1bf03f5dad7360fa41a32ffe9e834eb647f398e5b84747033a9cd8b23c16c076');
  assert.deepEqual(result.symbols, ['star', 'star', 'star']);
  assert.equal(result.score, '100'); assert.equal(result.reward_requested, '3');
  assert.deepEqual(await calculateResult(id), result);
  assert.equal(result.digest, createHash('sha256').update('agentzero-starlight-slots-v1:' + id, 'utf8').digest('hex'));
});
test('all 27 symbol combinations obey exactly one published reward tier', () => {
  const outcomes = { triple: 0, pair: 0, different: 0 };
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) {
    const digest = new Uint8Array(32); digest.set([a, b, c]);
    const result = resultFromDigest(digest); outcomes[result.outcome]++;
    if (a === b && b === c) assert.deepEqual([result.score, result.reward_requested], ['100', '3']);
    else if (a === b || b === c || a === c) assert.deepEqual([result.score, result.reward_requested], ['20', '1']);
    else assert.deepEqual([result.score, result.reward_requested], ['0', '0']);
  }
  assert.deepEqual(outcomes, { triple: 3, pair: 18, different: 6 });
});
test('digest validation and byte modulo remain part of the fixed rule', () => {
  assert.throws(() => resultFromDigest(new Uint8Array(3)), TypeError);
  const digest = new Uint8Array(32); digest.set([255, 254, 253]);
  assert.deepEqual(resultFromDigest(digest).reels, [0, 2, 1]);
});
