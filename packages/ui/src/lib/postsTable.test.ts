import { describe, expect, it } from 'vitest';
import type { WpPost } from '@dbp-wp/core';
import { createPostsTable, sortIndicator } from './postsTable';

function post(id: number, menuOrder: number, title: string): WpPost {
  return { id, type: 'post', status: 'publish', title, menuOrder, meta: {} };
}

const posts: WpPost[] = [post(2, 3, 'B'), post(1, 1, 'A'), post(3, 2, 'C')];

describe('createPostsTable', () => {
  it('returns rows in original order when unsorted', () => {
    const table = createPostsTable({ data: posts, sorting: [], onSortingChange() {} });
    expect(table.getRowModel().rows.map((r) => r.original.id)).toEqual([2, 1, 3]);
  });

  it('sorts by menuOrder ascending', () => {
    const table = createPostsTable({
      data: posts,
      sorting: [{ id: 'menuOrder', desc: false }],
      onSortingChange() {},
    });
    expect(table.getSortedRowModel().rows.map((r) => r.original.id)).toEqual([1, 3, 2]);
  });

  it('sorts by id descending', () => {
    const table = createPostsTable({
      data: posts,
      sorting: [{ id: 'id', desc: true }],
      onSortingChange() {},
    });
    expect(table.getSortedRowModel().rows.map((r) => r.original.id)).toEqual([3, 2, 1]);
  });
});

describe('sortIndicator', () => {
  it('maps sort direction to an arrow', () => {
    expect(sortIndicator('asc')).toBe(' ▲');
    expect(sortIndicator('desc')).toBe(' ▼');
    expect(sortIndicator(false)).toBe('');
  });
});
