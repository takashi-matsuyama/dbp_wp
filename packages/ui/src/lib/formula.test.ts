import { describe, expect, it } from 'vitest';
import type { WpPost } from '@dbp-wp/core';
import { computeMenuOrders } from './formula';

function post(id: number, menuOrder: number): WpPost {
  return { id, type: 'post', status: 'publish', title: 't', menuOrder, meta: {}, terms: {} };
}

const posts: WpPost[] = [post(2, 3), post(1, 1), post(3, 2)];

describe('computeMenuOrders', () => {
  it('numbers rows by display position', () => {
    const result = computeMenuOrders(posts, 'index * 10');
    expect(result.get(2)).toBe(10);
    expect(result.get(1)).toBe(20);
    expect(result.get(3)).toBe(30);
  });

  it('references id and the current menuOrder, rounding the result', () => {
    expect(computeMenuOrders([post(4, 0)], 'id / 2').get(4)).toBe(2);
    expect(computeMenuOrders([post(5, 7)], 'menuOrder + 0.5').get(5)).toBe(8);
  });

  it('throws on an invalid formula', () => {
    expect(() => computeMenuOrders(posts, 'index +')).toThrow();
    expect(() => computeMenuOrders(posts, 'unknownVar')).toThrow();
  });

  it('throws when a result is out of the menu_order range', () => {
    expect(() => computeMenuOrders([post(1, 0)], '3000000000')).toThrow(/out of range/);
  });

  it('rejects an over-long formula before evaluating', () => {
    expect(() => computeMenuOrders(posts, `1 + ${'0'.repeat(1001)}`)).toThrow(/too long/i);
  });
});
