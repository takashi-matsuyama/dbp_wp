import { describe, expect, it } from 'vitest';
import { parseBatchUpdates, parseBulkMetaDelete, parseMetaDelete } from './updates';

describe('parseBatchUpdates', () => {
  it('parses valid updates with editable fields', () => {
    expect(
      parseBatchUpdates({
        updates: [
          { id: 10, title: 'Renamed' },
          { id: 11, menuOrder: 3, status: 'draft' },
        ],
      }),
    ).toEqual([
      { id: 10, fields: { title: 'Renamed' } },
      { id: 11, fields: { menuOrder: 3, status: 'draft' } },
    ]);
  });

  it('rejects empty, oversized, or non-array payloads', () => {
    expect(parseBatchUpdates({ updates: [] })).toBeNull();
    expect(parseBatchUpdates({ updates: 'x' })).toBeNull();
    expect(parseBatchUpdates(null)).toBeNull();
  });

  it('rejects items with a bad id or no editable field', () => {
    expect(parseBatchUpdates({ updates: [{ id: 0, title: 'x' }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1.5, title: 'x' }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1 }] })).toBeNull();
  });

  it('rejects fields of the wrong type', () => {
    expect(parseBatchUpdates({ updates: [{ id: 1, menuOrder: 'nope' }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, title: 5 }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, menuOrder: 1.2 }] })).toBeNull();
  });

  it('rejects menuOrder outside the signed 32-bit range', () => {
    expect(parseBatchUpdates({ updates: [{ id: 1, menuOrder: 2_147_483_648 }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, menuOrder: -2_147_483_649 }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, menuOrder: 2_147_483_647 }] })).toEqual([
      { id: 1, fields: { menuOrder: 2_147_483_647 } },
    ]);
  });

  it('parses meta alongside fields and as a meta-only row', () => {
    expect(
      parseBatchUpdates({
        updates: [
          { id: 1, title: 'Hi', meta: { price: '10', stock: 4, active: true, note: null } },
          { id: 2, meta: { sku: 'A1' } },
        ],
      }),
    ).toEqual([
      { id: 1, fields: { title: 'Hi' }, meta: { price: '10', stock: 4, active: true, note: null } },
      { id: 2, fields: {}, meta: { sku: 'A1' } },
    ]);
  });

  it('treats an empty meta object as no meta (and rejects a row with nothing to do)', () => {
    expect(parseBatchUpdates({ updates: [{ id: 1, title: 'Hi', meta: {} }] })).toEqual([
      { id: 1, fields: { title: 'Hi' } },
    ]);
    expect(parseBatchUpdates({ updates: [{ id: 1, meta: {} }] })).toBeNull();
  });

  it('rejects non-scalar meta values and non-object meta', () => {
    expect(parseBatchUpdates({ updates: [{ id: 1, meta: { a: { nested: 1 } } }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, meta: { a: [1, 2] } }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, meta: [1, 2] }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, meta: 'x' }] })).toBeNull();
  });

  it('keeps a literal __proto__ meta key without polluting the prototype', () => {
    const parsed = parseBatchUpdates(
      JSON.parse('{"updates":[{"id":1,"meta":{"__proto__":"kept","sku":"A1"}}]}'),
    );
    expect(parsed).not.toBeNull();
    const meta = parsed?.[0]?.meta ?? {};
    expect(Object.keys(meta)).toEqual(expect.arrayContaining(['__proto__', 'sku']));
    expect(({} as Record<string, unknown>)['kept']).toBeUndefined();
  });
});

describe('parseMetaDelete', () => {
  it('parses a valid id and keys, dropping empty/non-string entries', () => {
    expect(parseMetaDelete({ id: 7, keys: ['price', '', 3, '_rel'] })).toEqual({
      id: 7,
      keys: ['price', '_rel'],
    });
  });

  it('rejects a bad id, missing/empty keys, or non-object body', () => {
    expect(parseMetaDelete({ id: 0, keys: ['price'] })).toBeNull();
    expect(parseMetaDelete({ id: 1.5, keys: ['price'] })).toBeNull();
    expect(parseMetaDelete({ id: 7, keys: [] })).toBeNull();
    expect(parseMetaDelete({ id: 7, keys: [1, ''] })).toBeNull();
    expect(parseMetaDelete({ id: 7 })).toBeNull();
    expect(parseMetaDelete(null)).toBeNull();
  });
});

describe('parseBulkMetaDelete', () => {
  it('parses a list of per-post deletions', () => {
    expect(
      parseBulkMetaDelete({
        deletes: [
          { id: 1, keys: ['price'] },
          { id: 2, keys: ['price', 'sku'] },
        ],
      }),
    ).toEqual([
      { id: 1, keys: ['price'] },
      { id: 2, keys: ['price', 'sku'] },
    ]);
  });

  it('rejects an empty list, a non-array, or any malformed item', () => {
    expect(parseBulkMetaDelete({ deletes: [] })).toBeNull();
    expect(parseBulkMetaDelete({ deletes: 'x' })).toBeNull();
    expect(parseBulkMetaDelete({ deletes: [{ id: 1, keys: ['price'] }, { id: 0, keys: ['x'] }] })).toBeNull();
    expect(parseBulkMetaDelete(null)).toBeNull();
  });
});
