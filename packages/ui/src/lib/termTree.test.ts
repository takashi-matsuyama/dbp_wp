import { describe, it, expect } from 'vitest';
import { flattenTermTree } from './termTree';
import type { WpTerm } from '@dbp-wp/core';

function term(id: number, name: string, parent = 0): WpTerm {
  return { id, name, parent, count: 0 };
}

describe('flattenTermTree', () => {
  it('nests children under parents with increasing depth', () => {
    const rows = flattenTermTree([term(1, 'Economy'), term(2, 'Trade', 1), term(3, 'Finance', 1)]);
    expect(rows.map((r) => [r.term.name, r.depth])).toEqual([
      ['Economy', 0],
      ['Trade', 1],
      ['Finance', 1],
    ]);
  });

  it('renders a term whose parent is absent as a root (orphans never vanish)', () => {
    const rows = flattenTermTree([term(2, 'Trade', 99)]);
    expect(rows).toEqual([{ term: term(2, 'Trade', 99), depth: 0 }]);
  });

  it('breaks a parent cycle, showing each term once', () => {
    // 1 → 2 → 1 (a closed cycle): neither is reachable from root 0, so both append as roots once.
    const rows = flattenTermTree([term(1, 'A', 2), term(2, 'B', 1)]);
    expect(rows.map((r) => r.term.id).sort()).toEqual([1, 2]);
    expect(rows).toHaveLength(2);
  });

  it('returns a flat list of name matches when filtered', () => {
    const rows = flattenTermTree(
      [term(1, 'Economy'), term(2, 'Trade', 1), term(3, 'Geography')],
      'e',
    );
    expect(rows.every((r) => r.depth === 0)).toBe(true);
    expect(rows.map((r) => r.term.name)).toEqual(['Economy', 'Trade', 'Geography']);
  });

  it('filters case-insensitively and ignores surrounding whitespace', () => {
    const rows = flattenTermTree([term(1, 'Economy'), term(2, 'Trade')], '  TRADE ');
    expect(rows.map((r) => r.term.name)).toEqual(['Trade']);
  });
});
