import type { RelationTarget, UpdatePostFields } from '@dbp-wp/core';

/** A single validated post update parsed from an API request. */
export interface BatchUpdate {
  id: number;
  fields: UpdatePostFields;
  /** Arbitrary meta to write via the companion plugin (omitted when none/empty). */
  meta?: Record<string, unknown>;
}

/** Maximum updates accepted in one batch request. */
export const MAX_UPDATES = 500;

/** Allowed characters for a REST post-type route slug. No dots: a `.`/`..` segment
 *  would be resolved by the URL parser and traverse the REST path. */
const ROUTE_SLUG = /^[a-z0-9_-]+$/i;

/**
 * Validate an optional REST post-type slug from a request body. Returns the default
 * `posts` when absent, the slug when valid, or null when present but malformed.
 */
export function parsePostTypeSlug(value: unknown): string | null {
  if (value === undefined) {
    return 'posts';
  }
  if (typeof value !== 'string' || !ROUTE_SLUG.test(value)) {
    return null;
  }
  return value;
}

// WordPress stores menu_order in a signed 32-bit column; reject values outside that range.
const MENU_ORDER_MIN = -2_147_483_648;
const MENU_ORDER_MAX = 2_147_483_647;

/**
 * Parse the three editable standard fields (title / menuOrder / status) from a record.
 * Returns a (possibly empty) fields object, or null if a present field has the wrong
 * type or `menuOrder` falls outside the signed 32-bit range. The caller decides whether
 * an empty result (no fields set) is acceptable.
 */
function parseEditableFields(record: Record<string, unknown>): UpdatePostFields | null {
  const fields: UpdatePostFields = {};
  if (record.title !== undefined) {
    if (typeof record.title !== 'string') {
      return null;
    }
    fields.title = record.title;
  }
  if (record.menuOrder !== undefined) {
    if (
      typeof record.menuOrder !== 'number' ||
      !Number.isInteger(record.menuOrder) ||
      record.menuOrder < MENU_ORDER_MIN ||
      record.menuOrder > MENU_ORDER_MAX
    ) {
      return null;
    }
    fields.menuOrder = record.menuOrder;
  }
  if (record.status !== undefined) {
    if (typeof record.status !== 'string') {
      return null;
    }
    fields.status = record.status;
  }
  if (record.featuredMedia !== undefined) {
    // A core REST field (no connector). Non-negative integer; 0 removes the featured image.
    if (
      typeof record.featuredMedia !== 'number' ||
      !Number.isSafeInteger(record.featuredMedia) ||
      record.featuredMedia < 0
    ) {
      return null;
    }
    fields.featuredMedia = record.featuredMedia;
  }
  if (record.terms !== undefined) {
    const terms = parseTermsInput(record.terms);
    if (terms === null) {
      return null;
    }
    // Only carry terms when at least one taxonomy is present; `{}` is nothing to do (a taxonomy
    // with an empty array — clearing its terms — still counts as present).
    if (Object.keys(terms).length > 0) {
      fields.terms = terms;
    }
  }
  return fields;
}

/** A validated term-creation request. */
export interface TermCreate {
  taxonomy: string;
  name: string;
  /** Parent term ID for a hierarchical taxonomy; omitted (top-level) when absent or 0. */
  parent?: number;
}

/**
 * Validate a term-creation payload (`{ taxonomy, name, parent? }`) from untrusted input. The
 * taxonomy must be a valid REST route slug, the name a non-empty (trimmed) string, and `parent`
 * (when present) a non-negative integer. Returns null on any malformed shape. A core REST call.
 */
export function parseTermCreate(body: unknown): TermCreate | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.taxonomy !== 'string' || !ROUTE_SLUG.test(record.taxonomy)) {
    return null;
  }
  if (typeof record.name !== 'string' || record.name.trim() === '') {
    return null;
  }
  const result: TermCreate = { taxonomy: record.taxonomy, name: record.name.trim() };
  if (record.parent !== undefined) {
    if (typeof record.parent !== 'number' || !Number.isSafeInteger(record.parent) || record.parent < 0) {
      return null;
    }
    if (record.parent > 0) {
      result.parent = record.parent;
    }
  }
  return result;
}

/** A validated term-update request (only the provided fields are changed). */
export interface TermUpdate {
  name?: string;
  parent?: number;
  slug?: string;
  description?: string;
}

/**
 * Validate a term-update payload (`{ name?, parent?, slug?, description? }`) from untrusted input.
 * `name` (when present) must be a non-empty trimmed string; `parent` a non-negative safe integer
 * (`0` moves the term to the top level); `slug` a valid REST slug; `description` a string. Returns
 * null on any malformed shape, or when nothing would change. A core REST call — no companion plugin.
 */
export function parseTermUpdate(body: unknown): TermUpdate | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const result: TermUpdate = {};
  if (record.name !== undefined) {
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      return null;
    }
    result.name = record.name.trim();
  }
  if (record.parent !== undefined) {
    if (
      typeof record.parent !== 'number' ||
      !Number.isSafeInteger(record.parent) ||
      record.parent < 0
    ) {
      return null;
    }
    result.parent = record.parent;
  }
  if (record.slug !== undefined) {
    if (typeof record.slug !== 'string' || !ROUTE_SLUG.test(record.slug)) {
      return null;
    }
    result.slug = record.slug;
  }
  if (record.description !== undefined) {
    if (typeof record.description !== 'string') {
      return null;
    }
    result.description = record.description;
  }
  // Require at least one field to change.
  if (Object.keys(result).length === 0) {
    return null;
  }
  return result;
}

/**
 * Validate a taxonomy-terms map (`{ <restBase>: number[] }`) from untrusted input. Each key
 * must be a valid REST route slug and each value an array of positive integer term IDs (an empty
 * array clears that taxonomy). Returns null on any malformed shape. A core REST field — no plugin.
 */
function parseTermsInput(value: unknown): Record<string, number[]> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const result: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  for (const [restBase, ids] of Object.entries(value as Record<string, unknown>)) {
    if (!ROUTE_SLUG.test(restBase) || !Array.isArray(ids)) {
      return null;
    }
    const clean: number[] = [];
    for (const id of ids) {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
        return null;
      }
      clean.push(id);
    }
    result[restBase] = clean;
  }
  return result;
}

/**
 * Parse optional meta from a record. Returns `undefined` when absent or empty, the
 * cleaned meta map when present, or null when malformed. Distinguishes "no meta" from
 * "invalid meta" via the `ok` flag so callers can reject the latter.
 */
function parseOptionalMeta(
  record: Record<string, unknown>,
): { ok: true; meta: Record<string, unknown> | undefined } | { ok: false } {
  if (record.meta === undefined) {
    return { ok: true, meta: undefined };
  }
  const parsedMeta = parseMetaInput(record.meta);
  if (parsedMeta === null) {
    return { ok: false };
  }
  return { ok: true, meta: Object.keys(parsedMeta).length > 0 ? parsedMeta : undefined };
}

/**
 * Validate a batch-update payload from untrusted input. Returns null on any malformed
 * item, empty list, or oversized batch. Each item must have a positive integer `id`
 * and at least one editable field (title / menuOrder / status) of the right type.
 */
export function parseBatchUpdates(body: unknown): BatchUpdate[] | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const updates = (body as Record<string, unknown>).updates;
  if (!Array.isArray(updates) || updates.length === 0 || updates.length > MAX_UPDATES) {
    return null;
  }

  const result: BatchUpdate[] = [];
  for (const item of updates) {
    if (typeof item !== 'object' || item === null) {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id) || record.id <= 0) {
      return null;
    }

    const fields = parseEditableFields(record);
    if (fields === null) {
      return null;
    }
    const meta = parseOptionalMeta(record);
    if (!meta.ok) {
      return null;
    }

    if (Object.keys(fields).length === 0 && meta.meta === undefined) {
      return null;
    }
    result.push(
      meta.meta !== undefined ? { id: record.id, fields, meta: meta.meta } : { id: record.id, fields },
    );
  }
  return result;
}

/** A single validated new-post creation parsed from an import request. */
export interface ImportCreate {
  fields: UpdatePostFields;
  /** Arbitrary meta to write via the companion plugin (omitted when none/empty). */
  meta?: Record<string, unknown>;
}

/**
 * Validate an import payload (`{ creates: [{ title?, menuOrder?, status?, meta? }] }`)
 * from untrusted input. Returns null on an empty/oversized list or any malformed item.
 * Unlike a batch update there is no `id` (these are new posts), but each item must still
 * carry at least one field or meta entry so it does not create a blank post.
 */
export function parseImportCreates(body: unknown): ImportCreate[] | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const creates = (body as Record<string, unknown>).creates;
  if (!Array.isArray(creates) || creates.length === 0 || creates.length > MAX_UPDATES) {
    return null;
  }

  const result: ImportCreate[] = [];
  for (const item of creates) {
    if (typeof item !== 'object' || item === null) {
      return null;
    }
    const record = item as Record<string, unknown>;
    const fields = parseEditableFields(record);
    if (fields === null) {
      return null;
    }
    const meta = parseOptionalMeta(record);
    if (!meta.ok) {
      return null;
    }
    if (Object.keys(fields).length === 0 && meta.meta === undefined) {
      return null;
    }
    result.push(meta.meta !== undefined ? { fields, meta: meta.meta } : { fields });
  }
  return result;
}

/**
 * Validate a meta map from untrusted input: a plain object whose values are scalars
 * (string / number / boolean) or null, with non-empty keys. Returns null on any
 * malformed shape. The companion plugin writes scalar values only.
 */
export function parseMetaInput(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  // Null-prototype map so pathological keys (`__proto__`, `constructor`) are stored as
  // ordinary own properties rather than dropped or touching any object prototype.
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.length === 0) {
      return null;
    }
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      return null;
    }
    result[key] = entry;
  }
  return result;
}

/** A validated parent-relation request: set a child's parent, or clear it. */
export interface RelationRequest {
  childId: number;
  childType: string;
  /** Parent to set, or null to clear the relation. */
  relation: RelationTarget | null;
}

/**
 * Validate a relation payload (`{ childId, childType?, parentId, parentType? }`) from
 * untrusted input. `parentId: null` clears the relation; a positive integer sets it (and
 * `parentType` is then required and must be a valid route slug). Returns null on any
 * malformed shape. Relation semantics beyond shape (e.g. no self-parent) are enforced by
 * the core client when the write is built.
 */
export function parseRelation(body: unknown): RelationRequest | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (
    typeof record.childId !== 'number' ||
    !Number.isSafeInteger(record.childId) ||
    record.childId <= 0
  ) {
    return null;
  }
  const childType = parsePostTypeSlug(record.childType);
  if (childType === null) {
    return null;
  }

  // Explicit null clears the relation; absence/other types are malformed (not a clear).
  if (record.parentId === null) {
    return { childId: record.childId, childType, relation: null };
  }
  if (
    typeof record.parentId !== 'number' ||
    !Number.isSafeInteger(record.parentId) ||
    record.parentId <= 0
  ) {
    return null;
  }
  if (typeof record.parentType !== 'string' || !ROUTE_SLUG.test(record.parentType)) {
    return null;
  }
  return {
    childId: record.childId,
    childType,
    relation: { parentId: record.parentId, parentType: record.parentType },
  };
}

/** A validated single-post body save (content + optional Markdown source). */
export interface SinglePostSave {
  /** Post body HTML to write to the core `content` field (`''` clears the body). */
  content: string;
  /**
   * Markdown source for `_dbp_wp_markdown`: a string sets it (Markdown mode), `null`
   * clears it (HTML mode on a post previously saved as Markdown), and omitting it leaves
   * the meta untouched (HTML-only post). Set/clear requires the companion plugin.
   */
  markdown?: string | null;
}

/**
 * Validate a single-post body save payload (`{ content, markdown? }`) from untrusted input.
 * `content` is required (a string; `''` is allowed and clears the body). `markdown`, when
 * present, must be a string (set) or `null` (clear). Returns null on any malformed shape.
 * The post `id` comes from the URL, and `type` is validated separately by the handler.
 */
export function parseSinglePostSave(body: unknown): SinglePostSave | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.content !== 'string') {
    return null;
  }
  const result: SinglePostSave = { content: record.content };
  if (record.markdown !== undefined) {
    if (record.markdown !== null && typeof record.markdown !== 'string') {
      return null;
    }
    result.markdown = record.markdown;
  }
  return result;
}

/** A validated per-post meta-deletion request. */
export interface MetaDelete {
  id: number;
  keys: string[];
}

/**
 * Validate a meta-delete payload from untrusted input. Returns null unless `id` is a positive
 * integer and `keys` is a non-empty array of non-empty strings. Any non-string or empty key
 * rejects the whole request (no silent dropping), matching the other batch parsers.
 */
export function parseMetaDelete(body: unknown): MetaDelete | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id) || record.id <= 0) {
    return null;
  }
  if (!Array.isArray(record.keys) || record.keys.length === 0) {
    return null;
  }
  // Reject the whole request if any key is invalid, rather than silently dropping it — matching
  // the other batch parsers, which fail on any malformed item instead of partially proceeding.
  for (const key of record.keys) {
    if (typeof key !== 'string' || key.length === 0) {
      return null;
    }
  }
  return { id: record.id, keys: record.keys as string[] };
}

/**
 * Validate a bulk meta-delete payload: `{ deletes: [{ id, keys }] }`. Returns null on an
 * empty/oversized list or any malformed item (each item is validated like a single
 * {@link parseMetaDelete}).
 */
export function parseBulkMetaDelete(body: unknown): MetaDelete[] | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const deletes = (body as Record<string, unknown>).deletes;
  if (!Array.isArray(deletes) || deletes.length === 0 || deletes.length > MAX_UPDATES) {
    return null;
  }
  const result: MetaDelete[] = [];
  for (const item of deletes) {
    const parsed = parseMetaDelete(item);
    if (!parsed) {
      return null;
    }
    result.push(parsed);
  }
  return result;
}
