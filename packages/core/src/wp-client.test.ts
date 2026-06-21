import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_META_KEY,
  buildAuthHeader,
  buildContentDisposition,
  buildMetaBody,
  buildPostBody,
  buildUpdateBody,
  hasConnectorNamespace,
  normalizeMedia,
  normalizePost,
  normalizePostForEdit,
  normalizePostTypes,
  normalizeSiteUrl,
  sanitizeMetaKeys,
} from './wp-client';
import type { WpPostResponse } from './types';

describe('buildAuthHeader', () => {
  it('builds an HTTP Basic header from Application Password credentials', () => {
    const header = buildAuthHeader({
      siteUrl: 'https://example.com',
      username: 'editor',
      applicationPassword: 'abcd efgh ijkl mnop',
    });

    const expected = Buffer.from('editor:abcd efgh ijkl mnop', 'utf-8').toString('base64');
    expect(header).toBe(`Basic ${expected}`);
  });

  it('encodes non-ASCII usernames as UTF-8', () => {
    const header = buildAuthHeader({
      siteUrl: 'https://example.com',
      username: 'café',
      applicationPassword: 'pw',
    });

    const expected = Buffer.from('café:pw', 'utf-8').toString('base64');
    expect(header).toBe(`Basic ${expected}`);
  });

  it('rejects usernames containing a colon', () => {
    expect(() =>
      buildAuthHeader({ siteUrl: 'https://example.com', username: 'a:b', applicationPassword: 'pw' }),
    ).toThrow();
  });
});

describe('normalizeSiteUrl', () => {
  it('accepts https and strips trailing slashes', () => {
    expect(normalizeSiteUrl('https://example.com/')).toBe('https://example.com');
  });

  it('preserves a subdirectory base path', () => {
    expect(normalizeSiteUrl('https://example.com/blog/')).toBe('https://example.com/blog');
  });

  it('allows http only for local hosts', () => {
    expect(normalizeSiteUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(() => normalizeSiteUrl('http://example.com')).toThrow();
  });

  it('rejects embedded credentials, query strings, and fragments', () => {
    expect(() => normalizeSiteUrl('https://user:pw@example.com')).toThrow();
    expect(() => normalizeSiteUrl('https://example.com/?a=1')).toThrow();
    expect(() => normalizeSiteUrl('https://example.com/#x')).toThrow();
  });
});

describe('buildUpdateBody', () => {
  it('maps camelCase fields to WordPress REST keys', () => {
    expect(buildUpdateBody({ title: 'Hi', menuOrder: 4, status: 'draft' })).toEqual({
      title: 'Hi',
      menu_order: 4,
      status: 'draft',
    });
  });

  it('omits fields that are not provided', () => {
    expect(buildUpdateBody({ menuOrder: 0 })).toEqual({ menu_order: 0 });
    expect(buildUpdateBody({})).toEqual({});
  });

  it('maps featuredMedia to featured_media, including 0 (which removes it)', () => {
    expect(buildUpdateBody({ featuredMedia: 42 })).toEqual({ featured_media: 42 });
    expect(buildUpdateBody({ featuredMedia: 0 })).toEqual({ featured_media: 0 });
  });

  it('maps content to the core content field, including an empty string (which clears it)', () => {
    expect(buildUpdateBody({ content: '<p>Hi</p>' })).toEqual({ content: '<p>Hi</p>' });
    expect(buildUpdateBody({ content: '' })).toEqual({ content: '' });
  });
});

describe('buildMetaBody', () => {
  it('wraps arbitrary meta in the companion plugin field', () => {
    expect(buildMetaBody({ price: '10', _rel: '5' })).toEqual({
      dbp_wp_meta: { price: '10', _rel: '5' },
    });
  });

  it('wraps an empty map', () => {
    expect(buildMetaBody({})).toEqual({ dbp_wp_meta: {} });
  });
});

describe('buildPostBody', () => {
  it('returns only standard fields when no meta is given', () => {
    expect(buildPostBody({ title: 'Hi', menuOrder: 2 })).toEqual({ title: 'Hi', menu_order: 2 });
  });

  it('folds connector meta in under dbp_wp_meta', () => {
    expect(buildPostBody({ title: 'Hi' }, { price: '10' })).toEqual({
      title: 'Hi',
      dbp_wp_meta: { price: '10' },
    });
  });

  it('supports a meta-only body', () => {
    expect(buildPostBody({}, { price: '10' })).toEqual({ dbp_wp_meta: { price: '10' } });
  });
});

describe('sanitizeMetaKeys', () => {
  it('keeps non-empty string keys', () => {
    expect(sanitizeMetaKeys(['price', '_rel'])).toEqual(['price', '_rel']);
  });

  it('drops empty and non-string entries', () => {
    expect(sanitizeMetaKeys(['a', '', 1, null, 'b'])).toEqual(['a', 'b']);
  });

  it('throws when not an array', () => {
    expect(() => sanitizeMetaKeys('price')).toThrow();
  });

  it('throws when no usable keys remain', () => {
    expect(() => sanitizeMetaKeys(['', 2])).toThrow();
  });
});

describe('hasConnectorNamespace', () => {
  it('detects the connector namespace in the REST index', () => {
    expect(hasConnectorNamespace(['wp/v2', 'dbp-wp/v1'])).toBe(true);
  });

  it('returns false when absent or malformed', () => {
    expect(hasConnectorNamespace(['wp/v2'])).toBe(false);
    expect(hasConnectorNamespace(undefined)).toBe(false);
    expect(hasConnectorNamespace('dbp-wp/v1')).toBe(false);
  });
});

describe('normalizePostTypes', () => {
  it('maps the /wp/v2/types object to a list using rest_base', () => {
    expect(
      normalizePostTypes({
        post: { name: 'Posts', slug: 'post', rest_base: 'posts' },
        page: { name: 'Pages', slug: 'page', rest_base: 'pages' },
      }),
    ).toEqual([
      { slug: 'post', restBase: 'posts', name: 'Posts' },
      { slug: 'page', restBase: 'pages', name: 'Pages' },
    ]);
  });

  it('skips entries without a valid rest_base and falls back to the key for missing fields', () => {
    expect(
      normalizePostTypes({
        cpt: { rest_base: 'cpts' },
        internal: { name: 'Internal' },
        traversal: { rest_base: '..' },
        spaced: { rest_base: 'bad base' },
      }),
    ).toEqual([{ slug: 'cpt', restBase: 'cpts', name: 'cpt' }]);
  });

  it('returns an empty list for a non-object', () => {
    expect(normalizePostTypes(null)).toEqual([]);
    expect(normalizePostTypes('x')).toEqual([]);
  });
});

describe('normalizePost relation fields', () => {
  function raw(meta: Record<string, unknown>): WpPostResponse {
    return {
      id: 5,
      type: 'post',
      status: 'publish',
      title: { rendered: 'r', raw: 'Post 5' },
      menu_order: 0,
      meta,
    };
  }

  it('sets parent and parentType together when both are valid', () => {
    const post = normalizePost(raw({ _dbp_wp_parent: 7, _dbp_wp_parent_type: 'pages' }));
    expect(post.parent).toBe(7);
    expect(post.parentType).toBe('pages');
  });

  it('treats a half-written relation as no relation (id without a type)', () => {
    const post = normalizePost(raw({ _dbp_wp_parent: 7 }));
    expect(post.parent).toBeUndefined();
    expect(post.parentType).toBeUndefined();
  });

  it('treats a half-written relation as no relation (type sanitized to empty)', () => {
    const post = normalizePost(raw({ _dbp_wp_parent: 7, _dbp_wp_parent_type: '' }));
    expect(post.parent).toBeUndefined();
    expect(post.parentType).toBeUndefined();
  });

  it('ignores a non-positive parent id even with a type present', () => {
    const post = normalizePost(raw({ _dbp_wp_parent: 0, _dbp_wp_parent_type: 'pages' }));
    expect(post.parent).toBeUndefined();
    expect(post.parentType).toBeUndefined();
  });

  it('leaves both unset when no relation meta is present', () => {
    const post = normalizePost(raw({}));
    expect(post.parent).toBeUndefined();
    expect(post.parentType).toBeUndefined();
  });
});

describe('normalizePost featured media', () => {
  function raw(featuredMedia?: number): WpPostResponse {
    return {
      id: 5,
      type: 'post',
      status: 'publish',
      title: { rendered: 'r', raw: 'Post 5' },
      menu_order: 0,
      meta: {},
      ...(featuredMedia !== undefined ? { featured_media: featuredMedia } : {}),
    };
  }

  it('sets featuredMedia from a positive featured_media', () => {
    expect(normalizePost(raw(42)).featuredMedia).toBe(42);
  });

  it('treats 0 as no featured image', () => {
    expect(normalizePost(raw(0)).featuredMedia).toBeUndefined();
  });

  it('leaves featuredMedia unset when the field is absent', () => {
    expect(normalizePost(raw()).featuredMedia).toBeUndefined();
  });
});

describe('normalizePostForEdit', () => {
  function raw(over: Partial<WpPostResponse> = {}): WpPostResponse {
    return {
      id: 9,
      type: 'post',
      status: 'draft',
      title: { rendered: 'R', raw: 'Title 9' },
      menu_order: 0,
      meta: {},
      content: { raw: '<p>Body</p>', rendered: '<p>Body</p>' },
      ...over,
    };
  }

  it('reads the raw body and the editable title (HTML mode by default)', () => {
    const edit = normalizePostForEdit(raw());
    expect(edit).toMatchObject({
      id: 9,
      type: 'post',
      status: 'draft',
      title: 'Title 9',
      content: '<p>Body</p>',
    });
    expect(edit.markdown).toBeUndefined();
  });

  it('falls back to an empty body when content.raw is absent', () => {
    const noContent: WpPostResponse = {
      id: 9,
      type: 'post',
      status: 'draft',
      title: { rendered: 'R', raw: 'Title 9' },
      menu_order: 0,
      meta: {},
    };
    expect(normalizePostForEdit(noContent).content).toBe('');
    expect(normalizePostForEdit(raw({ content: { rendered: 'x' } })).content).toBe('');
  });

  it('enters Markdown mode when _dbp_wp_markdown is a non-empty string', () => {
    const edit = normalizePostForEdit(raw({ meta: { [MARKDOWN_META_KEY]: '# Heading' } }));
    expect(edit.markdown).toBe('# Heading');
  });

  it('stays in HTML mode for an empty or absent Markdown source (registered string default)', () => {
    expect(normalizePostForEdit(raw({ meta: { [MARKDOWN_META_KEY]: '' } })).markdown).toBeUndefined();
    expect(normalizePostForEdit(raw({ meta: {} })).markdown).toBeUndefined();
  });

  it('prefers the raw title and falls back to rendered', () => {
    expect(normalizePostForEdit(raw({ title: { rendered: 'Only rendered' } })).title).toBe(
      'Only rendered',
    );
  });
});

describe('buildContentDisposition', () => {
  it('uses the basename and quotes an ASCII filename', () => {
    expect(buildContentDisposition('photo.png')).toBe(
      "attachment; filename=\"photo.png\"; filename*=UTF-8''photo.png",
    );
    expect(buildContentDisposition('/uploads/sub/img.jpg')).toBe(
      "attachment; filename=\"img.jpg\"; filename*=UTF-8''img.jpg",
    );
  });

  it('keeps a non-ASCII filename in filename* and an ASCII-safe fallback', () => {
    const value = buildContentDisposition('写真.png');
    expect(value).toContain('filename="__.png"'); // two non-ASCII chars → two underscores
    expect(value).toContain("filename*=UTF-8''%E5%86%99%E7%9C%9F.png");
  });

  it('strips quotes and CR/LF so the header cannot be broken', () => {
    const value = buildContentDisposition('a"b\r\nc.png');
    expect(value).not.toContain('"b');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.startsWith('attachment; filename="')).toBe(true);
  });

  it('falls back to a default when the name is empty after sanitizing', () => {
    expect(buildContentDisposition('')).toBe(
      "attachment; filename=\"upload\"; filename*=UTF-8''upload",
    );
  });
});

describe('normalizeMedia', () => {
  it('extracts id, urls, title, and mime from a raw media item', () => {
    expect(
      normalizeMedia({
        id: 12,
        source_url: 'https://example.com/wp-content/uploads/photo.png',
        mime_type: 'image/png',
        title: { rendered: 'Photo' },
        media_details: {
          sizes: {
            thumbnail: { source_url: 'https://example.com/wp-content/uploads/photo-150x150.png' },
            medium: { source_url: 'https://example.com/wp-content/uploads/photo-300x300.png' },
          },
        },
      }),
    ).toEqual({
      id: 12,
      sourceUrl: 'https://example.com/wp-content/uploads/photo.png',
      thumbnailUrl: 'https://example.com/wp-content/uploads/photo-150x150.png',
      title: 'Photo',
      mimeType: 'image/png',
    });
  });

  it('falls back to the source URL when no thumbnail size exists', () => {
    const media = normalizeMedia({
      id: 3,
      source_url: 'https://example.com/a.jpg',
      title: { rendered: 'A' },
    });
    expect(media.thumbnailUrl).toBe('https://example.com/a.jpg');
  });

  it('falls back to the medium size when no thumbnail size exists', () => {
    const media = normalizeMedia({
      id: 4,
      source_url: 'https://example.com/b.jpg',
      media_details: { sizes: { medium: { source_url: 'https://example.com/b-300.jpg' } } },
    });
    expect(media.thumbnailUrl).toBe('https://example.com/b-300.jpg');
  });

  it('degrades malformed input to empty fields rather than throwing', () => {
    expect(normalizeMedia(null)).toEqual({
      id: 0,
      sourceUrl: '',
      thumbnailUrl: '',
      title: '',
      mimeType: '',
    });
    expect(normalizeMedia({ id: 'x', title: 'not-an-object' })).toEqual({
      id: 0,
      sourceUrl: '',
      thumbnailUrl: '',
      title: '',
      mimeType: '',
    });
  });
});
