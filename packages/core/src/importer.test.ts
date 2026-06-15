import { describe, expect, it } from 'vitest';
import {
  buildImportPlan,
  normalizeStatus,
  parseCsv,
  parseJsonRecords,
  type ImportTarget,
} from './importer';

describe('parseCsv', () => {
  it('parses a simple table with a header row', () => {
    expect(parseCsv('title,price\nFirst,10\nSecond,20')).toEqual({
      headers: ['title', 'price'],
      rows: [
        ['First', '10'],
        ['Second', '20'],
      ],
    });
  });

  it('handles quoted fields with embedded commas, newlines, and "" escapes', () => {
    const text = 'title,note\n"Hello, world","line1\nline2"\n"She said ""hi""",x';
    expect(parseCsv(text)).toEqual({
      headers: ['title', 'note'],
      rows: [
        ['Hello, world', 'line1\nline2'],
        ['She said "hi"', 'x'],
      ],
    });
  });

  it('handles CRLF line endings and a trailing newline without a ghost row', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual({
      headers: ['a', 'b'],
      rows: [['1', '2']],
    });
  });

  it('keeps ragged rows as-is (missing trailing cells stay absent)', () => {
    expect(parseCsv('a,b,c\n1,2')).toEqual({
      headers: ['a', 'b', 'c'],
      rows: [['1', '2']],
    });
  });

  it('returns empty headers and rows for empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });

  it('throws on an unterminated quoted field rather than merging the rest of the file', () => {
    expect(() => parseCsv('a,b\n"open,1\n2,3')).toThrow(/unterminated/i);
  });
});

describe('parseJsonRecords', () => {
  it('builds a header union in first-seen order and aligns rows', () => {
    const text = JSON.stringify([
      { title: 'First', price: 10 },
      { title: 'Second', stock: 4 },
    ]);
    expect(parseJsonRecords(text)).toEqual({
      headers: ['title', 'price', 'stock'],
      rows: [
        ['First', '10', ''],
        ['Second', '', '4'],
      ],
    });
  });

  it('stringifies object/array cells and blanks null/undefined', () => {
    const text = JSON.stringify([{ a: { x: 1 }, b: [1, 2], c: null, d: true }]);
    expect(parseJsonRecords(text)).toEqual({
      headers: ['a', 'b', 'c', 'd'],
      rows: [['{"x":1}', '[1,2]', '', 'true']],
    });
  });

  it('throws when the JSON is not an array', () => {
    expect(() => parseJsonRecords('{"a":1}')).toThrow();
  });
});

describe('normalizeStatus', () => {
  it('maps known labels and values case-insensitively', () => {
    expect(normalizeStatus('Published')).toBe('publish');
    expect(normalizeStatus('DRAFT')).toBe('draft');
    expect(normalizeStatus(' private ')).toBe('private');
  });

  it('passes through unknown values trimmed', () => {
    expect(normalizeStatus('  custom_status ')).toBe('custom_status');
  });

  it('passes through inherited-key labels instead of resolving the prototype chain', () => {
    expect(normalizeStatus('constructor')).toBe('constructor');
    expect(normalizeStatus('toString')).toBe('toString');
    expect(normalizeStatus('__proto__')).toBe('__proto__');
  });
});

describe('buildImportPlan', () => {
  const mapping: ImportTarget[] = [
    { kind: 'title' },
    { kind: 'status' },
    { kind: 'menuOrder' },
    { kind: 'meta', key: 'price' },
    { kind: 'skip' },
  ];

  it('maps columns to fields and meta, normalizing status and menuOrder', () => {
    const table = {
      headers: ['title', 'status', 'order', 'price', 'ignored'],
      rows: [['Widget', 'Published', '3', '99', 'junk']],
    };
    expect(buildImportPlan(table, mapping)).toEqual([
      { fields: { title: 'Widget', status: 'publish', menuOrder: 3 }, meta: { price: '99' } },
    ]);
  });

  it('skips empty cells and rows that map to nothing', () => {
    const table = {
      headers: ['title', 'status', 'order', 'price', 'ignored'],
      rows: [
        ['', '', '', '', ''],
        ['Only title', '', '', '', ''],
      ],
    };
    expect(buildImportPlan(table, mapping)).toEqual([{ fields: { title: 'Only title' } }]);
  });

  it('ignores non-integer and out-of-range menuOrder cells', () => {
    const table = { headers: ['order'], rows: [['abc'], ['2.5'], ['999999999999']] };
    expect(buildImportPlan(table, [{ kind: 'menuOrder' }])).toEqual([]);
  });

  it('skips a meta target with an empty/whitespace key', () => {
    const table = { headers: ['  '], rows: [['value']] };
    expect(buildImportPlan(table, [{ kind: 'meta', key: '  ' }])).toEqual([]);
  });

  it('keeps a literal __proto__ meta key without polluting the prototype', () => {
    const table = { headers: ['__proto__'], rows: [['kept']] };
    const plan = buildImportPlan(table, [{ kind: 'meta', key: '__proto__' }]);
    expect(plan).toHaveLength(1);
    expect(Object.keys(plan[0]?.meta ?? {})).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['kept']).toBeUndefined();
  });
});
