import { describe, expect, it } from 'vitest';
import { buildAuthHeader, buildUpdateBody, normalizeSiteUrl } from './wp-client';

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

  it('rejects usernames containing a colon', () => {
    expect(() =>
      buildAuthHeader({ siteUrl: 'https://example.com', username: 'a:b', applicationPassword: 'pw' }),
    ).toThrow();
  });
});

describe('normalizeSiteUrl', () => {
  it('accepts https and strips trailing slashes', () => {
    expect(normalizeSiteUrl('https://example.com/')).toBe('https://example.com');
  });

  it('preserves a subdirectory base path', () => {
    expect(normalizeSiteUrl('https://example.com/blog/')).toBe('https://example.com/blog');
  });

  it('allows http only for local hosts', () => {
    expect(normalizeSiteUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(() => normalizeSiteUrl('http://example.com')).toThrow();
  });

  it('rejects embedded credentials, query strings, and fragments', () => {
    expect(() => normalizeSiteUrl('https://user:pw@example.com')).toThrow();
    expect(() => normalizeSiteUrl('https://example.com/?a=1')).toThrow();
    expect(() => normalizeSiteUrl('https://example.com/#x')).toThrow();
  });
});

describe('buildUpdateBody', () => {
  it('maps camelCase fields to WordPress REST keys', () => {
    expect(buildUpdateBody({ title: 'Hi', menuOrder: 4, status: 'draft' })).toEqual({
      title: 'Hi',
      menu_order: 4,
      status: 'draft',
    });
  });

  it('omits fields that are not provided', () => {
    expect(buildUpdateBody({ menuOrder: 0 })).toEqual({ menu_order: 0 });
    expect(buildUpdateBody({})).toEqual({});
  });
});
