import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadColumnSettings,
  parseColumnSettings,
  saveColumnSettings,
  type ColumnSettings,
} from './settings';

// A minimal in-memory localStorage stand-in (vitest runs in the node environment, which has
// no localStorage of its own).
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('parseColumnSettings', () => {
  it('parses a well-formed payload', () => {
    const raw = JSON.stringify({
      version: 1,
      columns: [
        { key: 'price', label: 'Price' },
        { key: 'sku', label: 'SKU' },
      ],
      childTemplate: '{{#each children}}{{ this.title }}{{/each}}',
    });
    expect(parseColumnSettings(raw)).toEqual<ColumnSettings>({
      columns: [
        { key: 'price', label: 'Price' },
        { key: 'sku', label: 'SKU' },
      ],
      childTemplate: '{{#each children}}{{ this.title }}{{/each}}',
    });
  });

  it('defaults a missing/blank label to the key', () => {
    const raw = JSON.stringify({ columns: [{ key: 'price' }, { key: 'sku', label: '' }] });
    expect(parseColumnSettings(raw).columns).toEqual([
      { key: 'price', label: 'price' },
      { key: 'sku', label: 'sku' },
    ]);
  });

  it('drops blank keys and de-duplicates by key (first wins)', () => {
    const raw = JSON.stringify({
      columns: [
        { key: '', label: 'X' },
        { key: 'a', label: 'First' },
        { key: 'a', label: 'Dup' },
        { label: 'no key' },
      ],
    });
    expect(parseColumnSettings(raw).columns).toEqual([{ key: 'a', label: 'First' }]);
  });

  it('returns empties for malformed or non-object input', () => {
    expect(parseColumnSettings('not json')).toEqual({ columns: [], childTemplate: '' });
    expect(parseColumnSettings('null')).toEqual({ columns: [], childTemplate: '' });
    expect(parseColumnSettings('[]')).toEqual({ columns: [], childTemplate: '' });
    expect(parseColumnSettings('42')).toEqual({ columns: [], childTemplate: '' });
  });

  it('ignores a non-string childTemplate', () => {
    expect(parseColumnSettings(JSON.stringify({ childTemplate: 123 })).childTemplate).toBe('');
  });

  it('keeps a prototype-like meta key as a plain column without pollution', () => {
    const raw = JSON.stringify({ columns: [{ key: '__proto__', label: 'P' }] });
    const out = parseColumnSettings(raw);
    expect(out.columns).toEqual([{ key: '__proto__', label: 'P' }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('ignores inherited (prototype-polluted) columns/childTemplate, reading own props only', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.columns = [{ key: 'injected', label: 'X' }];
    proto.childTemplate = 'inherited';
    try {
      // An empty stored object inherits these, but only own properties must be read.
      expect(parseColumnSettings('{}')).toEqual({ columns: [], childTemplate: '' });
    } finally {
      delete proto.columns;
      delete proto.childTemplate;
    }
  });
});

describe('loadColumnSettings / saveColumnSettings', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('round-trips settings for a (site, type)', () => {
    const settings: ColumnSettings = {
      columns: [{ key: 'price', label: 'Price' }],
      childTemplate: '{{ childCount }}',
    };
    saveColumnSettings('https://a.example', 'posts', settings);
    expect(loadColumnSettings('https://a.example', 'posts')).toEqual(settings);
  });

  it('namespaces by site and type (no cross-talk)', () => {
    saveColumnSettings('https://a.example', 'posts', {
      columns: [{ key: 'a', label: 'A' }],
      childTemplate: '',
    });
    saveColumnSettings('https://b.example', 'posts', {
      columns: [{ key: 'b', label: 'B' }],
      childTemplate: '',
    });
    saveColumnSettings('https://a.example', 'pages', {
      columns: [{ key: 'c', label: 'C' }],
      childTemplate: '',
    });
    expect(loadColumnSettings('https://a.example', 'posts').columns).toEqual([
      { key: 'a', label: 'A' },
    ]);
    expect(loadColumnSettings('https://b.example', 'posts').columns).toEqual([
      { key: 'b', label: 'B' },
    ]);
    expect(loadColumnSettings('https://a.example', 'pages').columns).toEqual([
      { key: 'c', label: 'C' },
    ]);
  });

  it('shares a "demo" namespace for a null site', () => {
    saveColumnSettings(null, 'posts', { columns: [{ key: 'd', label: 'D' }], childTemplate: '' });
    expect(loadColumnSettings(null, 'posts').columns).toEqual([{ key: 'd', label: 'D' }]);
  });

  it('returns empties when nothing is stored', () => {
    expect(loadColumnSettings('https://none.example', 'posts')).toEqual({
      columns: [],
      childTemplate: '',
    });
  });

  it('degrades to empties when storage is unavailable', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    // Neither call throws.
    expect(() =>
      saveColumnSettings('https://a.example', 'posts', { columns: [], childTemplate: '' }),
    ).not.toThrow();
    expect(loadColumnSettings('https://a.example', 'posts')).toEqual({
      columns: [],
      childTemplate: '',
    });
  });
});
