import { describe, expect, it } from 'vitest';
import { metaArg, resolveBody, validateStatus } from './mcp';

describe('validateStatus (publish gate)', () => {
  it('allows draft and pending', () => {
    expect(validateStatus('draft')).toBe('draft');
    expect(validateStatus('pending')).toBe('pending');
  });

  it('passes through undefined (no status change)', () => {
    expect(validateStatus(undefined)).toBeUndefined();
  });

  it('refuses publishing statuses (reserved for a human)', () => {
    expect(() => validateStatus('publish')).toThrow();
    expect(() => validateStatus('future')).toThrow();
    expect(() => validateStatus('private')).toThrow();
    expect(() => validateStatus('anything')).toThrow();
  });
});

describe('resolveBody', () => {
  it('returns nothing when neither markdown nor html is given', () => {
    expect(resolveBody({})).toEqual({});
  });

  it('renders Markdown to content and keeps the source', () => {
    const body = resolveBody({ markdown: '# Title' });
    expect(body.markdown).toBe('# Title');
    expect(body.content).toContain('<h1>Title</h1>');
  });

  it('passes HTML straight through as content (no markdown source)', () => {
    expect(resolveBody({ html: '<p>hi</p>' })).toEqual({ content: '<p>hi</p>' });
  });

  it('rejects providing both markdown and html', () => {
    expect(() => resolveBody({ markdown: '# x', html: '<p>x</p>' })).toThrow();
  });

  it('rejects a non-string body field', () => {
    expect(() => resolveBody({ markdown: 5 })).toThrow();
    expect(() => resolveBody({ html: {} })).toThrow();
  });
});

describe('metaArg', () => {
  it('returns undefined when meta is absent', () => {
    expect(metaArg({})).toBeUndefined();
  });

  it('returns a present meta object', () => {
    expect(metaArg({ meta: { sku: 'A1' } })).toEqual({ sku: 'A1' });
  });

  it('rejects a non-object meta', () => {
    expect(() => metaArg({ meta: 'x' })).toThrow();
    expect(() => metaArg({ meta: [1, 2] })).toThrow();
    expect(() => metaArg({ meta: null })).toThrow();
  });
});
