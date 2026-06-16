import { describe, expect, it } from 'vitest';
import {
  PARENT_META_KEY,
  PARENT_TYPE_META_KEY,
  RelationError,
  assertValidRelation,
  buildClearRelationMeta,
  buildSetRelationMeta,
  deriveChildren,
  getRelation,
} from './relation';
import type { WpPost } from './types';

function post(overrides: Partial<WpPost> & { id: number }): WpPost {
  return {
    type: 'post',
    status: 'publish',
    title: `Post ${overrides.id}`,
    menuOrder: 0,
    meta: {},
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
