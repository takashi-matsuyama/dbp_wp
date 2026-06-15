import { describe, expect, it } from 'vitest';
import { listPostsPath, printPostsPath } from './api';

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
