import { describe, expect, it } from 'vitest';
import { parseBatchUpdates } from './updates';

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
});
