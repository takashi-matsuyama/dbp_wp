import { describe, expect, it } from 'vitest';
import {
  parseBatchUpdates,
  parseBulkMetaDelete,
  parseImportCreates,
  parseMetaDelete,
  parsePostTypeSlug,
  parseRelation,
  parseSinglePostSave,
  parseTermCreate,
  parseTermUpdate,
} from './updates';

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

  it('parses featuredMedia (incl. 0 to remove) and rejects bad values', () => {
    expect(parseBatchUpdates({ updates: [{ id: 1, featuredMedia: 42 }] })).toEqual([
      { id: 1, fields: { featuredMedia: 42 } },
    ]);
    expect(parseBatchUpdates({ updates: [{ id: 1, featuredMedia: 0 }] })).toEqual([
      { id: 1, fields: { featuredMedia: 0 } },
    ]);
    expect(parseBatchUpdates({ updates: [{ id: 1, featuredMedia: -1 }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, featuredMedia: 1.5 }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, featuredMedia: 'x' }] })).toBeNull();
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

  it('parses taxonomy terms (per-taxonomy id arrays, empty array clears) and rejects bad shapes', () => {
    const parsed = parseBatchUpdates({ updates: [{ id: 1, terms: { categories: [1, 2], tags: [] } }] });
    expect(parsed).not.toBeNull();
    expect({ ...parsed?.[0]?.fields.terms }).toEqual({ categories: [1, 2], tags: [] });
    expect(parseBatchUpdates({ updates: [{ id: 1, terms: { 'bad base': [1] } }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, terms: { categories: [0] } }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, terms: { categories: ['x'] } }] })).toBeNull();
    expect(parseBatchUpdates({ updates: [{ id: 1, terms: [1, 2] }] })).toBeNull();
    // An empty terms object is nothing to do → the row is rejected when it is the only field.
    expect(parseBatchUpdates({ updates: [{ id: 1, terms: {} }] })).toBeNull();
  });
});

describe('parseImportCreates', () => {
  it('parses creates with fields and meta (no id required)', () => {
    expect(
      parseImportCreates({
        creates: [
          { title: 'New', status: 'draft' },
          { title: 'With meta', meta: { price: '10', stock: 4 } },
          { meta: { sku: 'A1' } },
        ],
      }),
    ).toEqual([
      { fields: { title: 'New', status: 'draft' } },
      { fields: { title: 'With meta' }, meta: { price: '10', stock: 4 } },
      { fields: {}, meta: { sku: 'A1' } },
    ]);
  });

  it('rejects empty, oversized, or non-array payloads', () => {
    expect(parseImportCreates({ creates: [] })).toBeNull();
    expect(parseImportCreates({ creates: 'x' })).toBeNull();
    expect(parseImportCreates(null)).toBeNull();
  });

  it('rejects a row with nothing to create (no fields, empty meta)', () => {
    expect(parseImportCreates({ creates: [{}] })).toBeNull();
    expect(parseImportCreates({ creates: [{ meta: {} }] })).toBeNull();
  });

  it('rejects wrong field types, out-of-range menuOrder, and non-scalar meta', () => {
    expect(parseImportCreates({ creates: [{ title: 5 }] })).toBeNull();
    expect(parseImportCreates({ creates: [{ menuOrder: 2_147_483_648 }] })).toBeNull();
    expect(parseImportCreates({ creates: [{ menuOrder: 1.5 }] })).toBeNull();
    expect(parseImportCreates({ creates: [{ meta: { a: { nested: 1 } } }] })).toBeNull();
    expect(parseImportCreates({ creates: [{ meta: [1, 2] }] })).toBeNull();
  });

  it('keeps a literal __proto__ meta key without polluting the prototype', () => {
    const parsed = parseImportCreates(
      JSON.parse('{"creates":[{"meta":{"__proto__":"kept","sku":"A1"}}]}'),
    );
    expect(parsed).not.toBeNull();
    const meta = parsed?.[0]?.meta ?? {};
    expect(Object.keys(meta)).toEqual(expect.arrayContaining(['__proto__', 'sku']));
    expect(({} as Record<string, unknown>)['kept']).toBeUndefined();
  });
});

describe('parseMetaDelete', () => {
  it('parses a valid id and all-string keys', () => {
    expect(parseMetaDelete({ id: 7, keys: ['price', '_rel'] })).toEqual({
      id: 7,
      keys: ['price', '_rel'],
    });
  });

  it('rejects the whole request if any key is invalid (no silent dropping)', () => {
    expect(parseMetaDelete({ id: 7, keys: ['price', ''] })).toBeNull();
    expect(parseMetaDelete({ id: 7, keys: ['price', 3, '_rel'] })).toBeNull();
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

describe('parseSinglePostSave', () => {
  it('parses an HTML-only save (content, no markdown — meta left untouched)', () => {
    expect(parseSinglePostSave({ content: '<p>Hi</p>' })).toEqual({ content: '<p>Hi</p>' });
  });

  it('accepts an empty content string (clears the body)', () => {
    expect(parseSinglePostSave({ content: '' })).toEqual({ content: '' });
  });

  it('parses a Markdown-mode save (content + markdown source)', () => {
    expect(parseSinglePostSave({ content: '<h1>T</h1>', markdown: '# T' })).toEqual({
      content: '<h1>T</h1>',
      markdown: '# T',
    });
  });

  it('parses a markdown clear (null) for demoting a post to HTML mode', () => {
    expect(parseSinglePostSave({ content: '<p>x</p>', markdown: null })).toEqual({
      content: '<p>x</p>',
      markdown: null,
    });
  });

  it('rejects a missing or non-string content', () => {
    expect(parseSinglePostSave({ markdown: '# T' })).toBeNull();
    expect(parseSinglePostSave({ content: 5 })).toBeNull();
    expect(parseSinglePostSave({})).toBeNull();
    expect(parseSinglePostSave(null)).toBeNull();
    expect(parseSinglePostSave('x')).toBeNull();
  });

  it('rejects a markdown value that is neither a string nor null', () => {
    expect(parseSinglePostSave({ content: '<p>x</p>', markdown: 5 })).toBeNull();
    expect(parseSinglePostSave({ content: '<p>x</p>', markdown: {} })).toBeNull();
  });
});

describe('parseTermCreate', () => {
  it('parses a flat term (name only)', () => {
    expect(parseTermCreate({ taxonomy: 'categories', name: 'News' })).toEqual({
      taxonomy: 'categories',
      name: 'News',
    });
  });

  it('trims the name and parses a parent for a hierarchical term', () => {
    expect(parseTermCreate({ taxonomy: 'categories', name: '  Trade  ', parent: 5 })).toEqual({
      taxonomy: 'categories',
      name: 'Trade',
      parent: 5,
    });
  });

  it('treats parent 0 as top-level (omitted)', () => {
    expect(parseTermCreate({ taxonomy: 'categories', name: 'X', parent: 0 })).toEqual({
      taxonomy: 'categories',
      name: 'X',
    });
  });

  it('rejects a bad taxonomy, empty name, or invalid parent', () => {
    expect(parseTermCreate({ taxonomy: 'bad base', name: 'X' })).toBeNull();
    expect(parseTermCreate({ taxonomy: 'a/b', name: 'X' })).toBeNull();
    expect(parseTermCreate({ taxonomy: 'categories', name: '   ' })).toBeNull();
    expect(parseTermCreate({ taxonomy: 'categories', name: 5 })).toBeNull();
    expect(parseTermCreate({ name: 'X' })).toBeNull();
    expect(parseTermCreate({ taxonomy: 'categories', name: 'X', parent: -1 })).toBeNull();
    expect(parseTermCreate({ taxonomy: 'categories', name: 'X', parent: 1.5 })).toBeNull();
    expect(parseTermCreate(null)).toBeNull();
  });
});

describe('parseTermUpdate', () => {
  it('parses a rename', () => {
    expect(parseTermUpdate({ name: '  News  ' })).toEqual({ name: 'News' });
  });

  it('parses a reparent, keeping parent 0 (move to top level)', () => {
    expect(parseTermUpdate({ parent: 5 })).toEqual({ parent: 5 });
    expect(parseTermUpdate({ parent: 0 })).toEqual({ parent: 0 });
  });

  it('parses slug and description', () => {
    expect(parseTermUpdate({ slug: 'news-2024', description: 'Latest' })).toEqual({
      slug: 'news-2024',
      description: 'Latest',
    });
  });

  it('rejects an empty change set', () => {
    expect(parseTermUpdate({})).toBeNull();
    expect(parseTermUpdate(null)).toBeNull();
  });

  it('rejects an empty name, negative/fractional parent, or bad slug', () => {
    expect(parseTermUpdate({ name: '   ' })).toBeNull();
    expect(parseTermUpdate({ name: 5 })).toBeNull();
    expect(parseTermUpdate({ parent: -1 })).toBeNull();
    expect(parseTermUpdate({ parent: 1.5 })).toBeNull();
    expect(parseTermUpdate({ slug: 'bad slug' })).toBeNull();
    expect(parseTermUpdate({ description: 5 })).toBeNull();
  });
});

describe('parsePostTypeSlug', () => {
  it('defaults to posts when absent and accepts valid slugs', () => {
    expect(parsePostTypeSlug(undefined)).toBe('posts');
    expect(parsePostTypeSlug('pages')).toBe('pages');
    expect(parsePostTypeSlug('my_cpt-2')).toBe('my_cpt-2');
  });

  it('rejects a non-string or malformed slug, including dot path segments', () => {
    expect(parsePostTypeSlug('')).toBeNull();
    expect(parsePostTypeSlug('bad slug')).toBeNull();
    expect(parsePostTypeSlug('a/b')).toBeNull();
    expect(parsePostTypeSlug('.')).toBeNull();
    expect(parsePostTypeSlug('..')).toBeNull();
    expect(parsePostTypeSlug('a.b')).toBeNull();
    expect(parsePostTypeSlug(5)).toBeNull();
  });
});

describe('parseRelation', () => {
  it('parses a set request with a parent id and type', () => {
    expect(parseRelation({ childId: 2, childType: 'posts', parentId: 7, parentType: 'pages' })).toEqual({
      childId: 2,
      childType: 'posts',
      relation: { parentId: 7, parentType: 'pages' },
    });
  });

  it('defaults childType to posts when absent', () => {
    expect(parseRelation({ childId: 2, parentId: 7, parentType: 'pages' })).toEqual({
      childId: 2,
      childType: 'posts',
      relation: { parentId: 7, parentType: 'pages' },
    });
  });

  it('parses a clear request (parentId null)', () => {
    expect(parseRelation({ childId: 2, childType: 'posts', parentId: null })).toEqual({
      childId: 2,
      childType: 'posts',
      relation: null,
    });
  });

  it('requires parentType when setting a parent', () => {
    expect(parseRelation({ childId: 2, parentId: 7 })).toBeNull();
    expect(parseRelation({ childId: 2, parentId: 7, parentType: 'bad type' })).toBeNull();
    expect(parseRelation({ childId: 2, parentId: 7, parentType: 'a/b' })).toBeNull();
  });

  it('rejects a missing/invalid childId or a non-null, non-positive parentId', () => {
    expect(parseRelation({ parentId: 7, parentType: 'pages' })).toBeNull();
    expect(parseRelation({ childId: 0, parentId: 7, parentType: 'pages' })).toBeNull();
    expect(parseRelation({ childId: 2, parentId: 0, parentType: 'pages' })).toBeNull();
    expect(parseRelation({ childId: 2, parentId: -1, parentType: 'pages' })).toBeNull();
    expect(parseRelation({ childId: 2, parentId: 1.5, parentType: 'pages' })).toBeNull();
  });

  it('rejects an absent parentId (neither set nor an explicit clear) and a bad childType', () => {
    expect(parseRelation({ childId: 2 })).toBeNull();
    expect(parseRelation({ childId: 2, childType: 'a.b', parentId: null })).toBeNull();
    expect(parseRelation(null)).toBeNull();
    expect(parseRelation('x')).toBeNull();
  });
});
