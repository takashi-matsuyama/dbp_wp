import type { WpTerm } from '@dbp-wp/core';

export interface TermTreeRow {
  term: WpTerm;
  /** Indent depth (0 = root). */
  depth: number;
}

/**
 * Flatten a flat term list into depth-annotated rows for an indented hierarchy view, shared by the
 * spreadsheet term picker and the taxonomy manager.
 *
 * - With a non-empty `filter`, returns the case-insensitive name matches as a flat list (depth 0) —
 *   a tree is meaningless once filtered.
 * - Otherwise it builds the parent→child tree. A term whose parent is not in the set renders as a
 *   root (orphans never vanish); a `seen` guard breaks cycles so each term appears once; any term
 *   still unreached (e.g. inside a closed parent cycle) is appended as a root.
 */
export function flattenTermTree(terms: WpTerm[], filter = ''): TermTreeRow[] {
  const needle = filter.trim().toLowerCase();
  if (needle !== '') {
    return terms
      .filter((t) => t.name.toLowerCase().includes(needle))
      .map((term) => ({ term, depth: 0 }));
  }
  const ids = new Set(terms.map((t) => t.id));
  const byParent = new Map<number, WpTerm[]>();
  for (const t of terms) {
    const parent = ids.has(t.parent) ? t.parent : 0; // orphans render as roots
    const list = byParent.get(parent);
    if (list) {
      list.push(t);
    } else {
      byParent.set(parent, [t]);
    }
  }
  const rows: TermTreeRow[] = [];
  const seen = new Set<number>();
  const visit = (parentId: number, depth: number): void => {
    for (const t of byParent.get(parentId) ?? []) {
      if (seen.has(t.id)) {
        continue;
      }
      seen.add(t.id);
      rows.push({ term: t, depth });
      visit(t.id, depth + 1);
    }
  };
  visit(0, 0);
  for (const t of terms) {
    if (!seen.has(t.id)) {
      rows.push({ term: t, depth: 0 });
    }
  }
  return rows;
}
