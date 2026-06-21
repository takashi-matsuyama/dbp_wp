import { describe, expect, it } from 'vitest';
import { listPostsPath, mediaListPath, printPostsPath, singlePostPath } from './api.cli';

describe('listPostsPath', () => {
  it('returns the base path with no query', () => {
    expect(listPostsPath()).toBe('/api/posts');
  });

  it('includes the post type when provided', () => {
    expect(listPostsPath({ type: 'pages' })).toBe('/api/posts?type=pages');
  });

  it('omits page 1 and includes higher page numbers', () => {
    expect(listPostsPath({ page: 1 })).toBe('/api/posts');
    expect(listPostsPath({ type: 'posts', page: 3 })).toBe('/api/posts?type=posts&page=3');
  });
});

describe('printPostsPath', () => {
  it('returns the base print path with no query', () => {
    expect(printPostsPath()).toBe('/api/print/posts');
  });

  it('includes type and higher page numbers, omitting page 1', () => {
    expect(printPostsPath({ type: 'pages' })).toBe('/api/print/posts?type=pages');
    expect(printPostsPath({ page: 1 })).toBe('/api/print/posts');
    expect(printPostsPath({ type: 'posts', page: 2 })).toBe('/api/print/posts?type=posts&page=2');
  });
});

describe('singlePostPath', () => {
  it('builds the single-post path with no type', () => {
    expect(singlePostPath(42)).toBe('/api/posts/42');
  });

  it('appends an encoded type when provided', () => {
    expect(singlePostPath(42, 'pages')).toBe('/api/posts/42?type=pages');
    expect(singlePostPath(7, 'my cpt')).toBe('/api/posts/7?type=my%20cpt');
  });
});

describe('mediaListPath', () => {
  it('returns the base media path with no query', () => {
    expect(mediaListPath()).toBe('/api/media');
  });

  it('omits page 1 and includes higher page numbers', () => {
    expect(mediaListPath({ page: 1 })).toBe('/api/media');
    expect(mediaListPath({ page: 2 })).toBe('/api/media?page=2');
  });

  it('includes a trimmed search term', () => {
    expect(mediaListPath({ search: '  flag ' })).toBe('/api/media?search=flag');
    expect(mediaListPath({ search: '   ' })).toBe('/api/media');
    expect(mediaListPath({ page: 3, search: 'sun' })).toBe('/api/media?page=3&search=sun');
  });
});
