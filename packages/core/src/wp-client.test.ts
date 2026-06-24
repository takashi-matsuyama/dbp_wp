import { describe, expect, it, vi } from 'vitest';
import {
  MARKDOWN_META_KEY,
  WpClient,
  buildAuthHeader,
  buildContentDisposition,
  buildMetaBody,
  buildPostBody,
  buildUpdateBody,
  computeMergedTermIds,
  hasConnectorNamespace,
  isPrivateAddress,
  normalizeMedia,
  normalizePost,
  normalizePostForEdit,
  normalizePostTypes,
  normalizeSiteUrl,
  normalizeTaxonomies,
  normalizeTerm,
  parseDeleteMetaResponse,
  sanitizeMetaKeys,
} from './wp-client';
import type { WpCredentials, WpPost, WpPostType, WpTaxonomy, WpPostResponse } from './types';

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

  it('rejects private, loopback, and link-local IP literals (SSRF defense)', () => {
    expect(() => normalizeSiteUrl('https://10.0.0.5')).toThrow();
    expect(() => normalizeSiteUrl('https://192.168.1.1')).toThrow();
    expect(() => normalizeSiteUrl('https://172.16.0.1')).toThrow();
    expect(() => normalizeSiteUrl('https://169.254.169.254')).toThrow(); // cloud metadata
    expect(() => normalizeSiteUrl('https://127.0.0.2')).toThrow();
    expect(() => normalizeSiteUrl('https://[fe80::1]')).toThrow();
    expect(() => normalizeSiteUrl('https://[fc00::1]')).toThrow();
  });

  it('rejects IPv4-mapped IPv6 literals (the URL parser canonicalizes them to hex)', () => {
    // new URL('https://[::ffff:127.0.0.1]').hostname === '[::ffff:7f00:1]'
    expect(() => normalizeSiteUrl('https://[::ffff:127.0.0.1]')).toThrow();
    expect(() => normalizeSiteUrl('https://[::ffff:10.0.0.1]')).toThrow();
    expect(() => normalizeSiteUrl('https://[::ffff:192.168.1.1]')).toThrow();
  });

  it('still allows the local-dev hosts and public sites', () => {
    expect(normalizeSiteUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeSiteUrl('https://127.0.0.1')).toBe('https://127.0.0.1');
    expect(normalizeSiteUrl('https://[::1]')).toBe('https://[::1]');
    expect(normalizeSiteUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeSiteUrl('https://172.15.0.1')).toBe('https://172.15.0.1'); // outside 172.16/12
  });
});

describe('isPrivateAddress', () => {
  it('flags private, loopback, link-local, and unspecified IPv4', () => {
    for (const ip of ['10.1.2.3', '172.31.255.255', '192.168.0.1', '127.0.0.1', '169.254.169.254', '0.0.0.0']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it('allows public IPv4 and addresses just outside private ranges', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '11.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  it('flags IPv6 loopback, ULA, link-local, and mapped private v4 (dotted and hex forms)', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12::3',
      'fe80::1',
      'febf::1', // top of fe80::/10
      '::ffff:10.0.0.1', // dotted mapped
      '::ffff:7f00:1', // hex mapped 127.0.0.1 (the URL-canonical form)
      '::ffff:a00:1', // hex mapped 10.0.0.1
      '::ffff:c0a8:101', // hex mapped 192.168.1.1
      '[fe80::1]', // bracketed (as a URL hostname arrives)
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it('does not flag DNS hostnames, public IPv6, or mapped public v4', () => {
    expect(isPrivateAddress('example.com')).toBe(false);
    expect(isPrivateAddress('wordpress.example.org')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
    expect(isPrivateAddress('::ffff:808:808')).toBe(false); // mapped 8.8.8.8 (public)
  });
});

describe('parseDeleteMetaResponse', () => {
  it('uses the JSON deleted list and post_id', () => {
    expect(parseDeleteMetaResponse('{"post_id":7,"deleted":["a","b"]}', 7, ['a', 'b', 'c'])).toEqual({
      postId: 7,
      deleted: ['a', 'b'],
    });
  });

  it('tolerates an empty/204 body as success for the requested keys', () => {
    expect(parseDeleteMetaResponse('', 7, ['a', 'b'])).toEqual({ postId: 7, deleted: ['a', 'b'] });
    expect(parseDeleteMetaResponse('   ', 7, ['x'])).toEqual({ postId: 7, deleted: ['x'] });
  });

  it('tolerates a non-JSON 2xx body as success', () => {
    expect(parseDeleteMetaResponse('OK', 5, ['k'])).toEqual({ postId: 5, deleted: ['k'] });
  });

  it('trusts the request id over a malformed post_id and filters non-strings', () => {
    expect(parseDeleteMetaResponse('{"post_id":"x","deleted":["a",2,null]}', 9, ['a'])).toEqual({
      postId: 9,
      deleted: ['a'],
    });
  });

  it('falls back to the request id for a non-positive or fractional post_id', () => {
    expect(parseDeleteMetaResponse('{"post_id":0,"deleted":["a"]}', 9, ['a']).postId).toBe(9);
    expect(parseDeleteMetaResponse('{"post_id":-3,"deleted":["a"]}', 9, ['a']).postId).toBe(9);
    expect(parseDeleteMetaResponse('{"post_id":1.5,"deleted":["a"]}', 9, ['a']).postId).toBe(9);
  });

  it('returns no deleted keys when the JSON list is absent or malformed', () => {
    expect(parseDeleteMetaResponse('{"post_id":3}', 3, ['a'])).toEqual({ postId: 3, deleted: [] });
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

  it('maps terms to per-taxonomy REST fields, including an empty array (clears them)', () => {
    expect(buildUpdateBody({ terms: { categories: [1, 2], tags: [] } })).toEqual({
      categories: [1, 2],
      tags: [],
    });
  });

  it('skips taxonomy keys that are not valid REST route segments', () => {
    expect(buildUpdateBody({ terms: { 'bad base': [1], 'a/b': [2], categories: [3] } })).toEqual({
      categories: [3],
    });
  });

  it('skips JS magic-name taxonomy keys (no prototype pollution / silent drop)', () => {
    const body = buildUpdateBody(
      JSON.parse('{"terms":{"__proto__":[1],"constructor":[2],"categories":[3]}}'),
    );
    expect(body).toEqual({ categories: [3] });
    expect(({} as Record<string, unknown>)['1']).toBeUndefined(); // prototype untouched
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

describe('normalizePost taxonomy terms', () => {
  function raw(extra: Record<string, unknown>): WpPostResponse {
    return {
      id: 5,
      type: 'post',
      status: 'publish',
      title: { rendered: 'r', raw: 'Post 5' },
      menu_order: 0,
      meta: {},
      ...extra,
    } as WpPostResponse;
  }

  it('captures number[] taxonomy fields keyed by REST base', () => {
    expect({ ...normalizePost(raw({ categories: [1, 2], tags: [3] })).terms }).toEqual({
      categories: [1, 2],
      tags: [3],
    });
  });

  it('omits empty arrays and non-numeric-array fields (author id, meta)', () => {
    expect({ ...normalizePost(raw({ categories: [], tags: [3], author: 7 })).terms }).toEqual({
      tags: [3],
    });
  });

  it('defaults to an empty map when no taxonomy fields are present', () => {
    expect({ ...normalizePost(raw({})).terms }).toEqual({});
  });
});

describe('normalizeTaxonomies', () => {
  it('maps the /taxonomies object to a list with rest_base, hierarchical, and types', () => {
    expect(
      normalizeTaxonomies({
        category: {
          name: 'Categories',
          slug: 'category',
          rest_base: 'categories',
          hierarchical: true,
          types: ['post', 'page'],
        },
        post_tag: { name: 'Tags', slug: 'post_tag', rest_base: 'tags', hierarchical: false },
      }),
    ).toEqual([
      { slug: 'category', restBase: 'categories', name: 'Categories', hierarchical: true, types: ['post', 'page'] },
      // `types` defaults to [] when WordPress reports none.
      { slug: 'post_tag', restBase: 'tags', name: 'Tags', hierarchical: false, types: [] },
    ]);
  });

  it('keeps only string entries in types (drops malformed ones)', () => {
    expect(
      normalizeTaxonomies({
        genre: { name: 'Genre', slug: 'genre', rest_base: 'genres', hierarchical: false, types: ['book', 5, null] },
      }),
    ).toEqual([{ slug: 'genre', restBase: 'genres', name: 'Genre', hierarchical: false, types: ['book'] }]);
  });

  it('skips entries without a valid rest_base and returns [] for a non-object', () => {
    expect(normalizeTaxonomies({ bad: { name: 'X' }, traversal: { rest_base: '..' } })).toEqual([]);
    expect(normalizeTaxonomies(null)).toEqual([]);
  });

  it('rejects a magic-name rest_base (passes the regex but is an unsafe object key)', () => {
    expect(
      normalizeTaxonomies(
        JSON.parse('{"x":{"name":"X","slug":"x","rest_base":"__proto__","hierarchical":false}}'),
      ),
    ).toEqual([]);
  });
});

describe('normalizeTerm', () => {
  it('extracts id, name, parent, and count', () => {
    expect(normalizeTerm({ id: 5, name: 'News', parent: 2, count: 12, slug: 'news' })).toEqual({
      id: 5,
      name: 'News',
      parent: 2,
      count: 12,
    });
  });

  it('degrades malformed input to safe defaults', () => {
    expect(normalizeTerm(null)).toEqual({ id: 0, name: '', parent: 0, count: 0 });
    expect(normalizeTerm({ id: 'x' })).toEqual({ id: 0, name: '', parent: 0, count: 0 });
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
      sizes: [
        {
          name: 'thumbnail',
          url: 'https://example.com/wp-content/uploads/photo-150x150.png',
          width: 0,
          height: 0,
        },
        {
          name: 'medium',
          url: 'https://example.com/wp-content/uploads/photo-300x300.png',
          width: 0,
          height: 0,
        },
        { name: 'full', url: 'https://example.com/wp-content/uploads/photo.png', width: 0, height: 0 },
      ],
    });
  });

  it('orders sizes smallest-first and synthesizes a full entry from the source', () => {
    const media = normalizeMedia({
      id: 7,
      source_url: 'https://example.com/c.jpg',
      mime_type: 'image/jpeg',
      media_details: {
        width: 2000,
        height: 1500,
        sizes: {
          medium: { source_url: 'https://example.com/c-300.jpg', width: 300, height: 225 },
          thumbnail: { source_url: 'https://example.com/c-150.jpg', width: 150, height: 150 },
          large: { source_url: 'https://example.com/c-1024.jpg', width: 1024, height: 768 },
        },
      },
    });
    expect(media.sizes.map((s) => s.name)).toEqual(['thumbnail', 'medium', 'large', 'full']);
    expect(media.sizes.at(-1)).toEqual({
      name: 'full',
      url: 'https://example.com/c.jpg',
      width: 2000,
      height: 1500,
    });
  });

  it('does not duplicate a full size already present in media_details.sizes', () => {
    const media = normalizeMedia({
      id: 8,
      source_url: 'https://example.com/d.jpg',
      mime_type: 'image/jpeg',
      media_details: {
        sizes: { full: { source_url: 'https://example.com/d.jpg', width: 800, height: 600 } },
      },
    });
    expect(media.sizes).toEqual([
      { name: 'full', url: 'https://example.com/d.jpg', width: 800, height: 600 },
    ]);
  });

  it('offers no sizes for a non-image attachment', () => {
    const media = normalizeMedia({
      id: 9,
      source_url: 'https://example.com/doc.pdf',
      mime_type: 'application/pdf',
    });
    expect(media.sizes).toEqual([]);
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
      sizes: [],
    });
    expect(normalizeMedia({ id: 'x', title: 'not-an-object' })).toEqual({
      id: 0,
      sourceUrl: '',
      thumbnailUrl: '',
      title: '',
      mimeType: '',
      sizes: [],
    });
  });
});

describe('computeMergedTermIds', () => {
  it('removes the source and adds the target', () => {
    expect(computeMergedTermIds([5, 7], 5, 9)).toEqual([7, 9]);
  });

  it('de-duplicates when the post already carries the target', () => {
    expect(computeMergedTermIds([5, 9], 5, 9)).toEqual([9]);
  });

  it('adds the target even when the source is absent', () => {
    expect(computeMergedTermIds([7], 5, 9)).toEqual([7, 9]);
  });

  it('collapses to just the target when the source was the only term', () => {
    expect(computeMergedTermIds([5], 5, 9)).toEqual([9]);
  });
});

describe('WpClient.mergeTerm', () => {
  const CREDS: WpCredentials = {
    siteUrl: 'https://example.com',
    username: 'u',
    applicationPassword: 'p',
  };
  const POST_TYPES: WpPostType[] = [{ slug: 'post', restBase: 'posts', name: 'Posts' }];
  const post = (id: number, ids: number[]): WpPost =>
    ({ id, terms: { categories: ids } }) as unknown as WpPost;
  const pageResult = (
    items: WpPost[],
    opts: { totalPages?: number; pagesReliable?: boolean } = {},
  ) => ({ items, totalPages: opts.totalPages ?? 1, pagesReliable: opts.pagesReliable ?? true });
  const tax = (types: string[]): WpTaxonomy => ({
    slug: 'category',
    restBase: 'categories',
    name: 'Categories',
    hierarchical: true,
    types,
  });

  it('reassigns the source term to the target across the taxonomy types, then deletes the source', async () => {
    const client = new WpClient(CREDS);
    vi.spyOn(client, 'listTaxonomies').mockResolvedValue([tax(['post'])]);
    vi.spyOn(client, 'listPostTypes').mockResolvedValue(POST_TYPES);
    vi.spyOn(client, 'listPostsByTerm').mockResolvedValue(
      pageResult([post(11, [5, 9]), post(12, [5])]),
    );
    const updateSpy = vi.spyOn(client, 'updatePost').mockResolvedValue({} as WpPost);
    const deleteSpy = vi.spyOn(client, 'deleteTerm').mockResolvedValue();

    const result = await client.mergeTerm('categories', 5, 9);

    expect(result).toEqual({ reassigned: 2, failed: [], deleted: true, truncated: false, canceled: false });
    // Post 11 already had the target (9), so the target must not be duplicated.
    expect(updateSpy).toHaveBeenCalledWith(11, { terms: { categories: [9] } }, 'posts');
    expect(updateSpy).toHaveBeenCalledWith(12, { terms: { categories: [9] } }, 'posts');
    expect(deleteSpy).toHaveBeenCalledWith('categories', 5);
  });

  it('keeps the source term (no delete) when a reassignment fails', async () => {
    const client = new WpClient(CREDS);
    vi.spyOn(client, 'listTaxonomies').mockResolvedValue([tax(['post'])]);
    vi.spyOn(client, 'listPostTypes').mockResolvedValue(POST_TYPES);
    vi.spyOn(client, 'listPostsByTerm').mockResolvedValue(
      pageResult([post(11, [5]), post(12, [5])]),
    );
    vi.spyOn(client, 'updatePost')
      .mockResolvedValueOnce({} as WpPost)
      .mockRejectedValueOnce(new Error('boom'));
    const deleteSpy = vi.spyOn(client, 'deleteTerm').mockResolvedValue();

    const result = await client.mergeTerm('categories', 5, 9);

    expect(result.reassigned).toBe(1);
    expect(result.failed).toEqual([{ id: 12, error: 'boom' }]);
    expect(result.deleted).toBe(false);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('keeps the source term when the taxonomy spans a post type unreachable over REST', async () => {
    const client = new WpClient(CREDS);
    // Attached to 'post' (reachable) and 'product' (no matching REST post type): cannot fully merge.
    vi.spyOn(client, 'listTaxonomies').mockResolvedValue([tax(['post', 'product'])]);
    vi.spyOn(client, 'listPostTypes').mockResolvedValue(POST_TYPES);
    vi.spyOn(client, 'listPostsByTerm').mockResolvedValue(pageResult([post(11, [5])]));
    vi.spyOn(client, 'updatePost').mockResolvedValue({} as WpPost);
    const deleteSpy = vi.spyOn(client, 'deleteTerm').mockResolvedValue();

    const result = await client.mergeTerm('categories', 5, 9);

    expect(result.reassigned).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.deleted).toBe(false);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('keeps the source term when the taxonomy reports no reachable post types', async () => {
    const client = new WpClient(CREDS);
    vi.spyOn(client, 'listTaxonomies').mockResolvedValue([tax([])]);
    vi.spyOn(client, 'listPostTypes').mockResolvedValue(POST_TYPES);
    const listSpy = vi.spyOn(client, 'listPostsByTerm');
    const deleteSpy = vi.spyOn(client, 'deleteTerm').mockResolvedValue();

    const result = await client.mergeTerm('categories', 5, 9);

    expect(result).toEqual({
      reassigned: 0,
      failed: [],
      deleted: false,
      truncated: true,
      canceled: false,
    });
    expect(listSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('keeps paging without a reliable page count, stopping at a short (non-full) page', async () => {
    const client = new WpClient(CREDS);
    vi.spyOn(client, 'listTaxonomies').mockResolvedValue([tax(['post'])]);
    vi.spyOn(client, 'listPostTypes').mockResolvedValue(POST_TYPES);
    const full = Array.from({ length: 100 }, (_, i) => post(1000 + i, [5]));
    // No X-WP-TotalPages (pagesReliable=false): a full page must not be trusted as the last page.
    const listSpy = vi
      .spyOn(client, 'listPostsByTerm')
      .mockResolvedValueOnce(pageResult(full, { pagesReliable: false }))
      .mockResolvedValueOnce(pageResult([post(1200, [5])], { pagesReliable: false }));
    vi.spyOn(client, 'updatePost').mockResolvedValue({} as WpPost);
    const deleteSpy = vi.spyOn(client, 'deleteTerm').mockResolvedValue();

    const result = await client.mergeTerm('categories', 5, 9);

    // Both pages were enumerated (101 posts), then the source was deleted.
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(result.reassigned).toBe(101);
    expect(result.deleted).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith('categories', 5);
  });

  it('rejects a taxonomy whose REST base collides with a reserved query parameter', async () => {
    const client = new WpClient(CREDS);
    vi.spyOn(client, 'listTaxonomies').mockResolvedValue([
      { slug: 'p', restBase: 'page', name: 'P', hierarchical: false, types: ['post'] },
    ]);
    vi.spyOn(client, 'listPostTypes').mockResolvedValue(POST_TYPES);
    // listPostsByTerm is the real method: it must throw on the reserved base before any network.
    const deleteSpy = vi.spyOn(client, 'deleteTerm').mockResolvedValue();

    await expect(client.mergeTerm('page', 5, 9)).rejects.toThrow(/reserved query parameter/);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('reports progress: the total up front, then cumulative counts per re-assignment', async () => {
    const client = new WpClient(CREDS);
    vi.spyOn(client, 'listTaxonomies').mockResolvedValue([tax(['post'])]);
    vi.spyOn(client, 'listPostTypes').mockResolvedValue(POST_TYPES);
    vi.spyOn(client, 'listPostsByTerm').mockResolvedValue(
      pageResult([post(11, [5]), post(12, [5])]),
    );
    vi.spyOn(client, 'updatePost').mockResolvedValue({} as WpPost);
    vi.spyOn(client, 'deleteTerm').mockResolvedValue();
    const progress: { reassigned: number; failed: number; total: number }[] = [];

    await client.mergeTerm('categories', 5, 9, { onProgress: (p) => progress.push({ ...p }) });

    expect(progress).toEqual([
      { reassigned: 0, failed: 0, total: 2 },
      { reassigned: 1, failed: 0, total: 2 },
      { reassigned: 2, failed: 0, total: 2 },
    ]);
  });

  it('cancels between re-assignments via the abort signal, keeping the source', async () => {
    const client = new WpClient(CREDS);
    vi.spyOn(client, 'listTaxonomies').mockResolvedValue([tax(['post'])]);
    vi.spyOn(client, 'listPostTypes').mockResolvedValue(POST_TYPES);
    vi.spyOn(client, 'listPostsByTerm').mockResolvedValue(
      pageResult([post(11, [5]), post(12, [5]), post(13, [5])]),
    );
    const controller = new AbortController();
    // Abort after the first re-assignment so the merge stops before finishing.
    const updateSpy = vi.spyOn(client, 'updatePost').mockImplementation(() => {
      controller.abort();
      return Promise.resolve({} as WpPost);
    });
    const deleteSpy = vi.spyOn(client, 'deleteTerm').mockResolvedValue();

    const result = await client.mergeTerm('categories', 5, 9, { signal: controller.signal });

    expect(result.canceled).toBe(true);
    expect(result.deleted).toBe(false);
    expect(result.reassigned).toBe(1);
    expect(updateSpy).toHaveBeenCalledTimes(1); // stopped before posts 12 and 13
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('keeps the source when canceled during the final re-assignment (post-loop re-check)', async () => {
    const client = new WpClient(CREDS);
    vi.spyOn(client, 'listTaxonomies').mockResolvedValue([tax(['post'])]);
    vi.spyOn(client, 'listPostTypes').mockResolvedValue(POST_TYPES);
    vi.spyOn(client, 'listPostsByTerm').mockResolvedValue(pageResult([post(11, [5])]));
    const controller = new AbortController();
    // The cancel lands while the only post is being re-assigned: the per-iteration check is past,
    // so the post-loop re-check is what must honor it.
    vi.spyOn(client, 'updatePost').mockImplementation(() => {
      controller.abort();
      return Promise.resolve({} as WpPost);
    });
    const deleteSpy = vi.spyOn(client, 'deleteTerm').mockResolvedValue();

    const result = await client.mergeTerm('categories', 5, 9, { signal: controller.signal });

    expect(result.reassigned).toBe(1); // the post was re-assigned
    expect(result.canceled).toBe(true); // but the late cancel is honored
    expect(result.deleted).toBe(false); // so the source is kept, not deleted
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('does not even start when the signal is already aborted', async () => {
    const client = new WpClient(CREDS);
    vi.spyOn(client, 'listTaxonomies').mockResolvedValue([tax(['post'])]);
    vi.spyOn(client, 'listPostTypes').mockResolvedValue(POST_TYPES);
    const listSpy = vi
      .spyOn(client, 'listPostsByTerm')
      .mockResolvedValue(pageResult([post(11, [5])]));
    const updateSpy = vi.spyOn(client, 'updatePost').mockResolvedValue({} as WpPost);
    const deleteSpy = vi.spyOn(client, 'deleteTerm').mockResolvedValue();

    const result = await client.mergeTerm('categories', 5, 9, { signal: AbortSignal.abort() });

    expect(result.canceled).toBe(true);
    expect(result.reassigned).toBe(0);
    expect(listSpy).not.toHaveBeenCalled(); // discovery is skipped too
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('rejects merging a term into itself', async () => {
    const client = new WpClient(CREDS);
    await expect(client.mergeTerm('categories', 5, 5)).rejects.toThrow(/itself/);
  });
});
