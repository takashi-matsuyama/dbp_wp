import type { UpdatePostFields } from '@dbp-wp/core';

/** A single validated post update parsed from an API request. */
export interface BatchUpdate {
  id: number;
  fields: UpdatePostFields;
  /** Arbitrary meta to write via the companion plugin (omitted when none/empty). */
  meta?: Record<string, unknown>;
}

/** Maximum updates accepted in one batch request. */
export const MAX_UPDATES = 500;

// WordPress stores menu_order in a signed 32-bit column; reject values outside that range.
const MENU_ORDER_MIN = -2_147_483_648;
const MENU_ORDER_MAX = 2_147_483_647;

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

    let meta: Record<string, unknown> | undefined;
    if (record.meta !== undefined) {
      const parsedMeta = parseMetaInput(record.meta);
      if (parsedMeta === null) {
        return null;
      }
      if (Object.keys(parsedMeta).length > 0) {
        meta = parsedMeta;
      }
    }

    if (Object.keys(fields).length === 0 && meta === undefined) {
      return null;
    }
    result.push(meta !== undefined ? { id: record.id, fields, meta } : { id: record.id, fields });
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

/** A validated per-post meta-deletion request. */
export interface MetaDelete {
  id: number;
  keys: string[];
}

/**
 * Validate a meta-delete payload from untrusted input. Returns null unless `id` is a
 * positive integer and `keys` is an array with at least one non-empty string
 * (non-string / empty entries are dropped).
 */
export function parseMetaDelete(body: unknown): MetaDelete | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id) || record.id <= 0) {
    return null;
  }
  if (!Array.isArray(record.keys)) {
    return null;
  }
  const keys = record.keys.filter(
    (key): key is string => typeof key === 'string' && key.length > 0,
  );
  if (keys.length === 0) {
    return null;
  }
  return { id: record.id, keys };
}
