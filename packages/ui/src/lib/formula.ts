import { SafeFormulaEngine, type WpPost } from '@dbp-wp/core';

// Formula evaluation is pure computation (no WordPress traffic, no secrets), so it runs
// in the browser for instant feedback. Each row gets a context of named numeric cells.
const engine = new SafeFormulaEngine();

/**
 * Evaluate a menu_order formula for each post, in display order. Returns a map of
 * post id to the rounded integer result. The per-row context exposes `index` (1-based
 * position), `id`, and the current `menuOrder`. Throws if the formula is invalid.
 */
export function computeMenuOrders(posts: WpPost[], formula: string): Map<number, number> {
  const result = new Map<number, number>();
  posts.forEach((post, i) => {
    const value = engine.evaluate(formula, {
      index: i + 1,
      id: post.id,
      menuOrder: post.menuOrder,
    });
    result.set(post.id, Math.round(value));
  });
  return result;
}
