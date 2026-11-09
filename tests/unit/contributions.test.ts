import { describe, expect, it } from 'vitest';
import { parseContributionUrl } from '../../apps/api/src/modules/contributions/service.js';

describe('GitHub contribution links', () => {
  it('accepts the three object types and ignores navigation fragments', () => {
    expect(parseContributionUrl('https://github.com/owner/repo/pull/42#discussion')).toEqual({ owner: 'owner', name: 'repo', kind: 'pull_request', objectId: '42' });
    expect(parseContributionUrl('https://github.com/owner/repo/issues/8?source=profile')).toMatchObject({ kind: 'issue', objectId: '8' });
    expect(parseContributionUrl(`https://github.com/owner/repo/commit/${'a'.repeat(40)}`)).toMatchObject({ kind: 'commit', objectId: 'a'.repeat(40) });
  });
  it('rejects alternate hosts, credentials, ports and ambiguous object references', () => {
    for (const url of [
      'https://github.com.evil.test/a/b/issues/1', 'http://github.com/a/b/issues/1',
      'https://alice@github.com/a/b/issues/1', 'https://github.com:8080/a/b/issues/1',
      'https://github.com/a/b/commit/main', 'https://github.com/a/b/commit/abcdef',
      'https://github.com/a/b/pull/0', 'https://github.com/a/b/issues/01',
      'https://github.com/a/b/issues/1/comments', 'not a URL',
    ]) expect(() => parseContributionUrl(url), url).toThrow();
  });
});
