import type { WpPost } from './types';

/**
 * Parent/child relations (MVP: links only).
 *
 * The relation is stored single-source on the **child**: `_dbp_wp_parent` holds the
 * parent post ID and `_dbp_wp_parent_type` holds the parent post type's REST route base.
 * The parent keeps no child list — a parent's children are derived from already-loaded
 * posts ({@link deriveChildren}), so there is no denormalized list to keep in sync.
 *
 * These keys are `_`-prefixed (protected) and are exposed over REST only because the
 * companion plugin registers them with `register_post_meta()` + an `edit_post`
 * `auth_callback`. They therefore travel through the standard core `meta` field — not the
 * connector's `dbp_wp_meta` field — so relation writes use a dedicated path.
 */

/** Meta key holding a child's parent post ID. */
export const PARENT_META_KEY = '_dbp_wp_parent';

/** Meta key holding the parent post type's REST route base. */
export const PARENT_TYPE_META_KEY = '_dbp_wp_parent_type';

/** Allowed characters for a REST route segment (post type slug); mirrors the WpClient check. */
const ROUTE_SEGMENT = /^[a-z0-9_-]+$/i;

/** A parent assignment for a child post. */
export interface RelationTarget {
  /** Parent post ID (positive integer). */
  parentId: number;
  /** Parent post type's REST route base (e.g. `pages`). */
  parentType: string;
}

/** Error thrown when a relation assignment is invalid (bad id/type, or self-parent). */
export class RelationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelationError';
  }
}

/**
 * Validate a parent assignment for a child. Throws {@link RelationError} when the parent
 * id is not a positive safe integer, the parent type is not a valid route segment, or the
 * parent is the child itself (post IDs are unique across types, so this catches a
 * self-parent regardless of type).
 */
export function assertValidRelation(childId: number, relation: RelationTarget): void {
  if (!Number.isSafeInteger(relation.parentId) || relation.parentId <= 0) {
    throw new RelationError(`Invalid parent id: ${String(relation.parentId)}`);
  }
  if (typeof relation.parentType !== 'string' || !ROUTE_SEGMENT.test(relation.parentType)) {
    throw new RelationError(`Invalid parent type: ${String(relation.parentType)}`);
  }
  if (relation.parentId === childId) {
    throw new RelationError('A post cannot be its own parent.');
  }
}

/**
 * Build the standard-`meta` body that sets a child's parent. Validates the assignment
 * first ({@link assertValidRelation}). The keys ride the core `meta` field, so the caller
 * sends `{ meta: <this> }`.
 */
export function buildSetRelationMeta(
  childId: number,
  relation: RelationTarget,
): Record<string, unknown> {
  assertValidRelation(childId, relation);
  return {
    [PARENT_META_KEY]: relation.parentId,
    [PARENT_TYPE_META_KEY]: relation.parentType,
  };
}

/**
 * Build the standard-`meta` body that clears a child's parent. Sending `null` for a
 * registered single meta key makes WordPress delete it, so no stale value is left behind.
 */
export function buildClearRelationMeta(): Record<string, unknown> {
  return {
    [PARENT_META_KEY]: null,
    [PARENT_TYPE_META_KEY]: null,
  };
}

/**
 * Read a post's parent relation from its normalized fields, or null when it has no parent.
 * Both a positive `parent` id and a non-empty `parentType` are required for a relation to
 * count (a half-written relation reads as none).
 */
export function getRelation(post: WpPost): RelationTarget | null {
  if (
    typeof post.parent === 'number' &&
    post.parent > 0 &&
    typeof post.parentType === 'string' &&
    post.parentType !== ''
  ) {
    return { parentId: post.parent, parentType: post.parentType };
  }
  return null;
}

/**
 * Derive a parent's children from already-loaded posts: every post whose `_dbp_wp_parent`
 * equals `parentId`. This covers the common case of same-type children visible in the
 * current grid; cross-type or off-grid children would need a server-side query (deferred).
 */
export function deriveChildren(posts: WpPost[], parentId: number): WpPost[] {
  if (!Number.isSafeInteger(parentId) || parentId <= 0) {
    return [];
  }
  return posts.filter((post) => post.parent === parentId);
}
