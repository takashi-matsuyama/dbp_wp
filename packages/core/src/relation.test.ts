import { describe, expect, it } from 'vitest';
import {
  PARENT_META_KEY,
  PARENT_TYPE_META_KEY,
  RelationError,
  assertValidRelation,
  buildChildRecord,
  buildClearRelationMeta,
  buildParentAggregate,
  buildSetRelationMeta,
  deriveChildren,
  getRelation,
  renderChildData,
} from './relation';
import { TemplateParseError } from './print';
import type { WpPost } from './types';

function post(overrides: Partial<WpPost> & { id: number }): WpPost {
  return {
    type: 'post',
    status: 'publish',
    title: `Post ${overrides.id}`,
    menuOrder: 0,
    meta: {},
    terms: {},
    ...overrides,
  };
}

describe('assertValidRelation', () => {
  it('accepts a positive parent id with a valid route segment', () => {
    expect(() => assertValidRelation(2, { parentId: 1, parentType: 'pages' })).not.toThrow();
  });

  it('rejects a non-positive or non-integer parent id', () => {
    expect(() => assertValidRelation(2, { parentId: 0, parentType: 'pages' })).toThrow(RelationError);
    expect(() => assertValidRelation(2, { parentId: -1, parentType: 'pages' })).toThrow(RelationError);
    expect(() => assertValidRelation(2, { parentId: 1.5, parentType: 'pages' })).toThrow(RelationError);
  });

  it('rejects a parent type that is not a REST route segment', () => {
    expect(() => assertValidRelation(2, { parentId: 1, parentType: 'pa ges' })).toThrow(RelationError);
    expect(() => assertValidRelation(2, { parentId: 1, parentType: '../wp' })).toThrow(RelationError);
    expect(() => assertValidRelation(2, { parentId: 1, parentType: '' })).toThrow(RelationError);
  });

  it('rejects making a post its own parent (ids are unique across types)', () => {
    expect(() => assertValidRelation(42, { parentId: 42, parentType: 'pages' })).toThrow(
      /own parent/,
    );
  });
});

describe('buildSetRelationMeta', () => {
  it('maps a valid relation to the two standard meta keys', () => {
    expect(buildSetRelationMeta(2, { parentId: 7, parentType: 'pages' })).toEqual({
      [PARENT_META_KEY]: 7,
      [PARENT_TYPE_META_KEY]: 'pages',
    });
  });

  it('validates before building (throws on a self-parent)', () => {
    expect(() => buildSetRelationMeta(7, { parentId: 7, parentType: 'pages' })).toThrow(
      RelationError,
    );
  });
});

describe('buildClearRelationMeta', () => {
  it('sends null for both keys so WordPress deletes them', () => {
    expect(buildClearRelationMeta()).toEqual({
      [PARENT_META_KEY]: null,
      [PARENT_TYPE_META_KEY]: null,
    });
  });
});

describe('getRelation', () => {
  it('returns the relation when both id and type are present', () => {
    expect(getRelation(post({ id: 2, parent: 7, parentType: 'pages' }))).toEqual({
      parentId: 7,
      parentType: 'pages',
    });
  });

  it('returns null when the post has no parent', () => {
    expect(getRelation(post({ id: 2 }))).toBeNull();
  });

  it('returns null for a half-written relation (id without type)', () => {
    expect(getRelation(post({ id: 2, parent: 7 }))).toBeNull();
    expect(getRelation(post({ id: 2, parentType: 'pages' }))).toBeNull();
  });

  it('returns null for a non-positive parent id', () => {
    expect(getRelation(post({ id: 2, parent: 0, parentType: 'pages' }))).toBeNull();
  });
});

describe('deriveChildren', () => {
  it('returns posts whose parent matches the given id', () => {
    const posts = [
      post({ id: 1 }),
      post({ id: 2, parent: 1, parentType: 'pages' }),
      post({ id: 3, parent: 1, parentType: 'pages' }),
      post({ id: 4, parent: 9, parentType: 'pages' }),
    ];
    expect(deriveChildren(posts, 1).map((p) => p.id)).toEqual([2, 3]);
  });

  it('returns an empty array when no posts match', () => {
    expect(deriveChildren([post({ id: 1 })], 99)).toEqual([]);
  });

  it('returns an empty array for an invalid parent id', () => {
    const posts = [post({ id: 2, parent: 1, parentType: 'pages' })];
    expect(deriveChildren(posts, 0)).toEqual([]);
    expect(deriveChildren(posts, -1)).toEqual([]);
  });
});

describe('buildChildRecord', () => {
  it('maps standard fields and flattens meta (arrays joined)', () => {
    const child = post({
      id: 5,
      title: 'Child',
      status: 'draft',
      menuOrder: 2,
      meta: { color: 'red', sizes: ['S', 'M'] },
    });
    expect(buildChildRecord(child)).toEqual({
      id: 5,
      title: 'Child',
      status: 'draft',
      menuOrder: 2,
      meta: { color: 'red', sizes: 'S, M' },
    });
  });

  it('overlays connector meta (dbpWpMeta) on core meta', () => {
    const child = post({ id: 5, meta: { color: 'red' }, dbpWpMeta: { color: 'blue', price: '9' } });
    expect(buildChildRecord(child).meta).toEqual({ color: 'blue', price: '9' });
  });

  it('keeps prototype-like meta keys as own entries without pollution', () => {
    const meta = JSON.parse('{"__proto__":"p","constructor":"c","ok":"v"}') as Record<
      string,
      unknown
    >;
    const rec = buildChildRecord(post({ id: 5, meta }));
    expect(Object.prototype.hasOwnProperty.call(rec.meta, '__proto__')).toBe(true);
    expect(rec.meta['__proto__']).toBe('p');
    expect(rec.meta.ok).toBe('v');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('buildParentAggregate', () => {
  it('carries the parent fields plus children and childCount', () => {
    const parent = post({ id: 1, title: 'Parent', meta: { region: 'asia' } });
    const children = [post({ id: 2, title: 'A' }), post({ id: 3, title: 'B' })];
    const agg = buildParentAggregate(parent, children);
    expect(agg.id).toBe(1);
    expect(agg.title).toBe('Parent');
    expect(agg.meta).toEqual({ region: 'asia' });
    expect(agg.childCount).toBe(2);
    expect(agg.children.map((c) => c.title)).toEqual(['A', 'B']);
  });
});

describe('renderChildData', () => {
  const posts = [
    post({ id: 1, title: 'Parent' }),
    post({ id: 2, parent: 1, parentType: 'post', title: 'India', meta: { pop: '1400' } }),
    post({ id: 3, parent: 1, parentType: 'post', title: 'China', meta: { pop: '1410' } }),
    post({ id: 4, parent: 9, parentType: 'post', title: 'Other' }),
  ];

  it('renders each same-type, in-grid child through the template', () => {
    const tpl = '{{#each children}}{{ this.title }} ({{ this.meta.pop }}); {{/each}}';
    expect(renderChildData(tpl, posts[0]!, posts)).toBe('India (1400); China (1410); ');
  });

  it('exposes childCount and the parent fields', () => {
    expect(renderChildData('{{ title }} has {{ childCount }}', posts[0]!, posts)).toBe(
      'Parent has 2',
    );
  });

  it('renders in plain-text (non-escaping) mode', () => {
    const ampPosts = [
      post({ id: 1, title: 'P' }),
      post({ id: 2, parent: 1, parentType: 'post', title: 'A & B' }),
    ];
    expect(renderChildData('{{#each children}}{{ this.title }}{{/each}}', ampPosts[0]!, ampPosts)).toBe(
      'A & B',
    );
  });

  it('renders nothing for a parent with no children', () => {
    expect(renderChildData('{{#each children}}{{ this.title }}{{/each}}', posts[3]!, posts)).toBe('');
  });

  it('returns empty string for an empty template', () => {
    expect(renderChildData('', posts[0]!, posts)).toBe('');
  });

  it('throws TemplateParseError on an unbalanced each', () => {
    expect(() => renderChildData('{{#each children}}x', posts[0]!, posts)).toThrow(
      TemplateParseError,
    );
  });
});
