import type { UpdatePostFields } from '@dbp-wp/core';

/** A single validated post update parsed from an API request. */
export interface BatchUpdate {
  id: number;
  fields: UpdatePostFields;
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

    if (Object.keys(fields).length === 0) {
      return null;
    }
    result.push({ id: record.id, fields });
  }
  return result;
}
