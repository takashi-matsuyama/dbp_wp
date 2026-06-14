import { describe, expect, it } from 'vitest';
import { buildAuthHeader } from './wp-client';

describe('buildAuthHeader', () => {
  it('builds an HTTP Basic header from Application Password credentials', () => {
    const header = buildAuthHeader({
      siteUrl: 'https://example.com',
      username: 'editor',
      applicationPassword: 'abcd efgh ijkl mnop',
    });

    const expected = Buffer.from('editor:abcd efgh ijkl mnop', 'utf-8').toString('base64');
    expect(header).toBe(`Basic ${expected}`);
  });

  it('encodes non-ASCII usernames as UTF-8', () => {
    const header = buildAuthHeader({
      siteUrl: 'https://example.com',
      username: 'café',
      applicationPassword: 'pw',
    });

    const expected = Buffer.from('café:pw', 'utf-8').toString('base64');
    expect(header).toBe(`Basic ${expected}`);
  });
});
