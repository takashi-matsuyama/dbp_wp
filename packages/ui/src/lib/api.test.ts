import { describe, expect, it } from 'vitest';
import { listPostsPath } from './api';

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
