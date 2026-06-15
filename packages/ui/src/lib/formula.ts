import { SafeFormulaEngine, type WpPost } from '@dbp-wp/core';

// Formula evaluation is pure computation (no WordPress traffic, no secrets), so it runs
// in the browser for instant feedback. Each row gets a context of named numeric cells.
const engine = new SafeFormulaEngine();

// WordPress stores menu_order in a signed 32-bit column; mirror the server-side bound so
// out-of-range results are caught at apply time rather than failing on save.
const MENU_ORDER_MIN = -2_147_483_648;
const MENU_ORDER_MAX = 2_147_483_647;

// Bound the work a single formula apply can trigger (defensive against pathological input).
const MAX_FORMULA_LENGTH = 1000;
const MAX_ROWS = 10_000;

/**
 * Evaluate a menu_order formula for each post, in display order. Returns a map of post id
 * to the rounded integer result. The per-row context exposes `index` (1-based position),
 * `id`, and `menuOrder` — the latter being the persisted value, so reapplying a formula
 * is idempotent rather than compounding unsaved drafts. Throws if the formula is invalid
 * or any result falls outside the menu_order range.
 */
export function computeMenuOrders(posts: WpPost[], formula: string): Map<number, number> {
  if (formula.length > MAX_FORMULA_LENGTH) {
    throw new Error(`Formula is too long (max ${MAX_FORMULA_LENGTH} characters).`);
  }
  if (posts.length > MAX_ROWS) {
    throw new Error(`Too many rows for one formula (max ${MAX_ROWS}).`);
  }
  const result = new Map<number, number>();
  posts.forEach((post, i) => {
    const value = engine.evaluate(formula, {
      index: i + 1,
      id: post.id,
      menuOrder: post.menuOrder,
    });
    const rounded = Math.round(value);
    if (rounded < MENU_ORDER_MIN || rounded > MENU_ORDER_MAX) {
      throw new Error(`menu_order result out of range: ${rounded}`);
    }
    result.set(post.id, rounded);
  });
  return result;
}
