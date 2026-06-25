import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration tests for the cli HTTP server: a real ephemeral server, driven over node:http (which,
// unlike fetch, lets us set the forbidden Host / Sec-Fetch-Site headers the security guards inspect).
// The upstream WordPress client is mocked, so no network and the route plumbing is what's exercised.

// The mock WordPress client: the methods the routes under test call. Each is a vi.fn so a
// test can set its resolved value or implementation.
interface MockClient {
  listPostTypes: ReturnType<typeof vi.fn>;
  listPosts: ReturnType<typeof vi.fn>;
  listPostsForPrint: ReturnType<typeof vi.fn>;
  updatePost: ReturnType<typeof vi.fn>;
  createPost: ReturnType<typeof vi.fn>;
  getPostForEdit: ReturnType<typeof vi.fn>;
  updatePostBody: ReturnType<typeof vi.fn>;
  deletePostMeta: ReturnType<typeof vi.fn>;
  setRelation: ReturnType<typeof vi.fn>;
  clearRelation: ReturnType<typeof vi.fn>;
  detectConnector: ReturnType<typeof vi.fn>;
  uploadMedia: ReturnType<typeof vi.fn>;
  listMedia: ReturnType<typeof vi.fn>;
  resolveMedia: ReturnType<typeof vi.fn>;
  listTaxonomies: ReturnType<typeof vi.fn>;
  listTerms: ReturnType<typeof vi.fn>;
  listAllTerms: ReturnType<typeof vi.fn>;
  resolveTerms: ReturnType<typeof vi.fn>;
  createTerm: ReturnType<typeof vi.fn>;
  updateTerm: ReturnType<typeof vi.fn>;
  deleteTerm: ReturnType<typeof vi.fn>;
  mergeTerm: ReturnType<typeof vi.fn>;
}

// The vi.mock factory is hoisted above imports, so the per-test mock client lives in a hoisted box.
const mock = vi.hoisted(() => ({ client: {} as MockClient }));

vi.mock('@dbp-wp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbp-wp/core')>();
  // Keep the real error classes (handlers do `e instanceof WpRequestError`); swap only the client.
  // `new WpClient(creds)` returns the current test's mock client.
  return { ...actual, WpClient: vi.fn(() => mock.client) };
});

import { RelationError, WpClient, WpRequestError, type WpCredentials } from '@dbp-wp/core';
import type { CredentialsStore, StoredConnection } from './credentials-store';
import { createDbpServer, type ConnectionState } from './server';

const CREDS: WpCredentials = {
  siteUrl: 'https://example.com',
  username: 'u',
  applicationPassword: 'p',
};

// A vi.fn-backed credential store. Defaults to "no persistence" (most routes never touch it);
// the connection-route tests reconfigure isAvailable/load/save/peek per case to exercise the
// remember / use-saved / forget paths. Defaults are restored in beforeEach (vi.clearAllMocks
// clears call history but not implementations, so a per-test override would otherwise leak).
const store = {
  isAvailable: vi.fn<() => boolean>(() => false),
  load: vi.fn<() => Promise<WpCredentials | null>>(() => Promise.resolve(null)),
  save: vi.fn<(credentials: WpCredentials) => Promise<void>>(() => Promise.resolve()),
  clear: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  peek: vi.fn<() => Promise<StoredConnection | null>>(() => Promise.resolve(null)),
} satisfies CredentialsStore;

const state: ConnectionState = { credentials: CREDS, connectorAvailable: null };
let server: Server;
let port: number;

beforeAll(async () => {
  server = createDbpServer({ state, uiDir: null, store });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  // Await full close so the listening socket is released before the test file exits.
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  // Clear call history (incl. the hoisted WpClient constructor mock) so it can't leak across tests.
  vi.clearAllMocks();
  mock.client = {
    listPostTypes: vi.fn(),
    listPosts: vi.fn(),
    listPostsForPrint: vi.fn(),
    updatePost: vi.fn(),
    createPost: vi.fn(),
    getPostForEdit: vi.fn(),
    updatePostBody: vi.fn(),
    deletePostMeta: vi.fn(),
    setRelation: vi.fn(),
    clearRelation: vi.fn(),
    detectConnector: vi.fn(),
    uploadMedia: vi.fn(),
    listMedia: vi.fn(),
    resolveMedia: vi.fn(),
    listTaxonomies: vi.fn(),
    listTerms: vi.fn(),
    listAllTerms: vi.fn(),
    resolveTerms: vi.fn(),
    createTerm: vi.fn(),
    updateTerm: vi.fn(),
    deleteTerm: vi.fn(),
    mergeTerm: vi.fn(),
  };
  // Restore the store's default (no-persistence) behavior; connection tests override per case.
  store.isAvailable.mockReturnValue(false);
  store.load.mockResolvedValue(null);
  store.save.mockResolvedValue(undefined);
  store.clear.mockResolvedValue(undefined);
  store.peek.mockResolvedValue(null);
  state.credentials = CREDS;
  state.connectorAvailable = null;
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Make one request over node:http (so we can set Host / Sec-Fetch-Site) and buffer the response.
 *  Rejects on a socket error or if the response never completes within the timeout, so a route that
 *  closes without `end()` fails fast with a clear message instead of hanging until the runner kills it. */
function call(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`request to ${method} ${path} did not complete within 5s`));
    }, 5000);
    // node:http only auto-frames a written body for body-bearing methods; a DELETE body is
    // silently dropped unless we set Content-Length, so always frame an explicit body here.
    const headers =
      opts.body !== undefined
        ? { 'content-length': String(Buffer.byteLength(opts.body)), ...opts.headers }
        : opts.headers;
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const JSON_H = { 'content-type': 'application/json' };

/** Assert a status and that the body is a JSON error object with a non-empty string `error`
 *  (so a route that loses its error payload — blank/wrong body — fails instead of passing on status alone). */
function expectJsonError(res: Res, status: number): void {
  expect(res.status).toBe(status);
  const body = JSON.parse(res.body) as { error?: unknown };
  expect(typeof body.error).toBe('string');
  expect(body.error).not.toBe('');
}

const parseLines = (body: string): Record<string, unknown>[] =>
  body
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('createDbpServer — security guards', () => {
  it('rejects a non-loopback Host header (DNS rebinding protection)', async () => {
    const res = await call('GET', '/api/types', { headers: { host: 'evil.example' } });
    expect(res.status).toBe(403);
  });

  it('rejects a cross-site browser request (CSRF protection)', async () => {
    const res = await call('GET', '/api/types', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(res.status).toBe(403);
  });

  it('allows a same-origin request through (sec-fetch-site: same-origin)', async () => {
    mock.client.listPostTypes.mockResolvedValue([]);
    const res = await call('GET', '/api/types', { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(200);
  });

  it('returns 409 when not connected', async () => {
    state.credentials = null;
    const res = await call('POST', '/api/terms/5/merge?taxonomy=categories', {
      headers: JSON_H,
      body: JSON.stringify({ into: 9 }),
    });
    expect(res.status).toBe(409);
  });
});

describe('term routes', () => {
  it('POST /api/terms creates a term', async () => {
    mock.client.createTerm.mockResolvedValue({ id: 7, name: 'News', parent: 0, count: 0 });
    const res = await call('POST', '/api/terms', {
      headers: JSON_H,
      body: JSON.stringify({ taxonomy: 'categories', name: 'News' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ term: { id: 7, name: 'News', parent: 0, count: 0 } });
    // The route must forward the parsed taxonomy + payload to the client.
    expect(mock.client.createTerm).toHaveBeenCalledWith('categories', { name: 'News' });
  });

  it('PATCH /api/terms/:id renames a term', async () => {
    mock.client.updateTerm.mockResolvedValue({ id: 5, name: 'Renamed', parent: 0, count: 3 });
    const res = await call('PATCH', '/api/terms/5?taxonomy=categories', {
      headers: JSON_H,
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { term: { name: string } }).term.name).toBe('Renamed');
    // The id (from the path) and taxonomy (from the query) and body must reach the client.
    expect(mock.client.updateTerm).toHaveBeenCalledWith('categories', 5, { name: 'Renamed' });
  });

  it('DELETE /api/terms/:id deletes a term', async () => {
    mock.client.deleteTerm.mockResolvedValue(undefined);
    const res = await call('DELETE', '/api/terms/5?taxonomy=categories');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true });
    expect(mock.client.deleteTerm).toHaveBeenCalledWith('categories', 5);
  });

  it('surfaces a WordPress 403 as 403 on update', async () => {
    mock.client.updateTerm.mockRejectedValue(new WpRequestError(403, '/wp/v2/categories/5', 'forbidden'));
    const res = await call('PATCH', '/api/terms/5?taxonomy=categories', {
      headers: JSON_H,
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(403);
  });

  it('surfaces a WordPress 403 as 403 on create', async () => {
    mock.client.createTerm.mockRejectedValue(new WpRequestError(403, '/wp/v2/categories', 'forbidden'));
    const res = await call('POST', '/api/terms', {
      headers: JSON_H,
      body: JSON.stringify({ taxonomy: 'categories', name: 'X' }),
    });
    expect(res.status).toBe(403);
  });

  it('surfaces a WordPress 403 as 403 on delete', async () => {
    mock.client.deleteTerm.mockRejectedValue(new WpRequestError(403, '/wp/v2/categories/5', 'forbidden'));
    const res = await call('DELETE', '/api/terms/5?taxonomy=categories');
    expect(res.status).toBe(403);
  });

  it('rejects an invalid taxonomy slug', async () => {
    const res = await call('PATCH', '/api/terms/5?taxonomy=bad%20base', {
      headers: JSON_H,
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(400);
    expect(mock.client.updateTerm).not.toHaveBeenCalled();
  });
});

describe('term merge (NDJSON stream)', () => {
  it('streams progress lines then a final result line on success', async () => {
    mock.client.mergeTerm.mockImplementation(
      (
        _tax: string,
        _from: number,
        _to: number,
        o: { onProgress?: (p: unknown) => void },
      ) => {
        o.onProgress?.({ reassigned: 1, failed: 0, total: 2 });
        o.onProgress?.({ reassigned: 2, failed: 0, total: 2 });
        return Promise.resolve({
          reassigned: 2,
          failed: [],
          deleted: true,
          truncated: false,
          canceled: false,
        });
      },
    );
    const res = await call('POST', '/api/terms/5/merge?taxonomy=categories', {
      headers: JSON_H,
      body: JSON.stringify({ into: 9 }),
    });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/x-ndjson');
    expect(parseLines(res.body)).toEqual([
      { type: 'progress', reassigned: 1, failed: 0, total: 2 },
      { type: 'progress', reassigned: 2, failed: 0, total: 2 },
      { type: 'result', reassigned: 2, failed: [], deleted: true, truncated: false, canceled: false },
    ]);
  });

  it('emits a progress line then an in-band error line when the merge throws mid-stream (403)', async () => {
    // Emit one progress line, then fail — exercising the partial-progress-then-error transition
    // (the hardest stream state), not just an immediate rejection.
    mock.client.mergeTerm.mockImplementation(
      (_tax: string, _from: number, _to: number, o: { onProgress?: (p: unknown) => void }) => {
        o.onProgress?.({ reassigned: 1, failed: 0, total: 3 });
        return Promise.reject(new WpRequestError(403, '/wp/v2/categories/5', 'forbidden'));
      },
    );
    const res = await call('POST', '/api/terms/5/merge?taxonomy=categories', {
      headers: JSON_H,
      body: JSON.stringify({ into: 9 }),
    });
    // The stream already sent 200, so the error rides as the final NDJSON line, not a 403 status.
    expect(res.status).toBe(200);
    const lines = parseLines(res.body);
    expect(lines[0]).toEqual({ type: 'progress', reassigned: 1, failed: 0, total: 3 });
    const last = lines.at(-1);
    expect(last?.type).toBe('error');
    expect(String(last?.error)).toMatch(/permission/i);
  });

  it('rejects merging a term into itself before streaming (400)', async () => {
    const res = await call('POST', '/api/terms/5/merge?taxonomy=categories', {
      headers: JSON_H,
      body: JSON.stringify({ into: 5 }),
    });
    expect(res.status).toBe(400);
    expect(mock.client.mergeTerm).not.toHaveBeenCalled();
  });

  it('rejects a missing taxonomy before streaming (400)', async () => {
    const res = await call('POST', '/api/terms/5/merge', {
      headers: JSON_H,
      body: JSON.stringify({ into: 9 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid merge body before streaming (400)', async () => {
    // `into` missing → parseTermMerge fails → 400 before any stream begins.
    const res = await call('POST', '/api/terms/5/merge?taxonomy=categories', {
      headers: JSON_H,
      body: JSON.stringify({ wrong: 9 }),
    });
    expect(res.status).toBe(400);
    expect(mock.client.mergeTerm).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON content type (415)', async () => {
    const res = await call('POST', '/api/terms/5/merge?taxonomy=categories', { body: '{}' });
    expect(res.status).toBe(415);
  });

  it('rejects a non-POST method (405)', async () => {
    const res = await call('GET', '/api/terms/5/merge?taxonomy=categories');
    expect(res.status).toBe(405);
  });

  it('aborts the merge when the client disconnects (signal propagated, source kept)', async () => {
    let captured: AbortSignal | undefined;
    mock.client.mergeTerm.mockImplementation(
      (
        _tax: string,
        _from: number,
        _to: number,
        o: { onProgress?: (p: unknown) => void; signal: AbortSignal },
      ) => {
        captured = o.signal;
        o.onProgress?.({ reassigned: 0, failed: 0, total: 5 });
        return new Promise((resolve) => {
          o.signal.addEventListener('abort', () =>
            resolve({ reassigned: 0, failed: [], deleted: false, truncated: false, canceled: true }),
          );
        });
      },
    );
    await new Promise<void>((done, fail) => {
      // Fail fast (rather than hang to the runner timeout) if the first progress chunk never arrives.
      const timer = setTimeout(() => fail(new Error('no progress chunk received before disconnect')), 5000);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/terms/5/merge?taxonomy=categories',
          headers: JSON_H,
        },
        (res) => {
          res.once('data', () => req.destroy()); // first progress chunk arrived → hang up
          res.on('error', () => {});
          res.on('close', () => {
            clearTimeout(timer);
            done();
          });
        },
      );
      req.on('error', () => {}); // destroy surfaces a socket error; ignore
      req.write(JSON.stringify({ into: 9 }));
      req.end();
    });
    // The server must have turned the disconnect into an abort on the signal it gave core.
    await vi.waitFor(() => expect(captured?.aborted).toBe(true));
  });
});

describe('types route', () => {
  it('returns the post types from the client', async () => {
    mock.client.listPostTypes.mockResolvedValue([{ slug: 'post', restBase: 'posts', name: 'Posts' }]);
    const res = await call('GET', '/api/types');
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { types: unknown[] }).types).toHaveLength(1);
  });

  it('returns an empty list (not 409) when not connected', async () => {
    state.credentials = null;
    const res = await call('GET', '/api/types');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ types: [] });
    expect(mock.client.listPostTypes).not.toHaveBeenCalled();
  });

  it('surfaces an upstream failure as 502', async () => {
    mock.client.listPostTypes.mockRejectedValue(new Error('network down'));
    const res = await call('GET', '/api/types');
    expectJsonError(res, 502);
  });

  it('rejects a non-GET method (405)', async () => {
    const res = await call('POST', '/api/types', { headers: JSON_H, body: '{}' });
    expect(res.status).toBe(405);
  });
});

describe('posts list route', () => {
  it('lists posts, forwarding type + page to the client', async () => {
    mock.client.listPosts.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const res = await call('GET', '/api/posts?type=page&page=2');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ posts: [{ id: 1 }, { id: 2 }], unconfigured: false });
    expect(mock.client.listPosts).toHaveBeenCalledWith({ type: 'page', page: 2 });
  });

  it('returns an unconfigured marker (not 409) when not connected', async () => {
    state.credentials = null;
    const res = await call('GET', '/api/posts');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ posts: [], unconfigured: true });
    expect(mock.client.listPosts).not.toHaveBeenCalled();
  });

  it('surfaces an upstream failure as 502', async () => {
    mock.client.listPosts.mockRejectedValue(new Error('upstream'));
    const res = await call('GET', '/api/posts');
    expectJsonError(res, 502);
  });

  it('rejects a non-GET method (405)', async () => {
    const res = await call('POST', '/api/posts', { headers: JSON_H, body: '{}' });
    expect(res.status).toBe(405);
  });
});

describe('print posts route', () => {
  it('lists print records, forwarding type + page', async () => {
    mock.client.listPostsForPrint.mockResolvedValue([{ id: 1, title: 'A' }]);
    const res = await call('GET', '/api/print/posts?type=posts&page=1');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ records: [{ id: 1, title: 'A' }], unconfigured: false });
    expect(mock.client.listPostsForPrint).toHaveBeenCalledWith({ type: 'posts', page: 1 });
  });

  it('returns an unconfigured marker when not connected', async () => {
    state.credentials = null;
    const res = await call('GET', '/api/print/posts');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ records: [], unconfigured: true });
  });

  it('surfaces an upstream failure as 502', async () => {
    mock.client.listPostsForPrint.mockRejectedValue(new Error('upstream'));
    const res = await call('GET', '/api/print/posts');
    expectJsonError(res, 502);
  });

  it('rejects a non-GET method (405)', async () => {
    const res = await call('POST', '/api/print/posts', { headers: JSON_H, body: '{}' });
    expect(res.status).toBe(405);
  });
});

describe('single post route — GET (fetch for editing)', () => {
  it('fetches a post for editing, forwarding id + type', async () => {
    mock.client.getPostForEdit.mockResolvedValue({ id: 7, content: '<p>hi</p>' });
    const res = await call('GET', '/api/posts/7?type=page');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ post: { id: 7, content: '<p>hi</p>' } });
    expect(mock.client.getPostForEdit).toHaveBeenCalledWith(7, 'page');
  });

  it('maps a WordPress 404 to 404 (post not found)', async () => {
    mock.client.getPostForEdit.mockRejectedValue(new WpRequestError(404, '/wp/v2/posts/7', 'missing'));
    const res = await call('GET', '/api/posts/7');
    expect(res.status).toBe(404);
  });

  it('rejects an invalid post id (0) with 400', async () => {
    const res = await call('GET', '/api/posts/0');
    expect(res.status).toBe(400);
    expect(mock.client.getPostForEdit).not.toHaveBeenCalled();
  });

  it('rejects an invalid post type with 400', async () => {
    const res = await call('GET', '/api/posts/7?type=bad%20type');
    expect(res.status).toBe(400);
    expect(mock.client.getPostForEdit).not.toHaveBeenCalled();
  });

  it('returns 409 when not connected', async () => {
    state.credentials = null;
    const res = await call('GET', '/api/posts/7');
    expect(res.status).toBe(409);
  });

  it('surfaces a non-404 upstream failure as 502', async () => {
    mock.client.getPostForEdit.mockRejectedValue(new Error('upstream'));
    const res = await call('GET', '/api/posts/7');
    expectJsonError(res, 502);
  });
});

describe('single post route — POST (save body)', () => {
  it('saves an HTML-only body without requiring the connector', async () => {
    mock.client.updatePostBody.mockResolvedValue({ id: 7, content: '<p>x</p>' });
    const res = await call('POST', '/api/posts/7', {
      headers: JSON_H,
      body: JSON.stringify({ content: '<p>x</p>', type: 'posts' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ post: { id: 7, content: '<p>x</p>' } });
    expect(mock.client.updatePostBody).toHaveBeenCalledWith(7, 'posts', { content: '<p>x</p>' });
    // An HTML-only save must not gate on the connector.
    expect(mock.client.detectConnector).not.toHaveBeenCalled();
  });

  it('saves a Markdown body when the connector is available, forwarding the source', async () => {
    mock.client.detectConnector.mockResolvedValue(true);
    mock.client.updatePostBody.mockResolvedValue({ id: 7, content: '<p>x</p>' });
    const res = await call('POST', '/api/posts/7', {
      headers: JSON_H,
      body: JSON.stringify({ content: '<p>x</p>', markdown: '# x', type: 'posts' }),
    });
    expect(res.status).toBe(200);
    expect(mock.client.updatePostBody).toHaveBeenCalledWith(7, 'posts', {
      content: '<p>x</p>',
      markdown: '# x',
    });
  });

  it('refuses a Markdown save with 409 when the connector is absent', async () => {
    mock.client.detectConnector.mockResolvedValue(false);
    const res = await call('POST', '/api/posts/7', {
      headers: JSON_H,
      body: JSON.stringify({ content: '<p>x</p>', markdown: '# x', type: 'posts' }),
    });
    expect(res.status).toBe(409);
    expect(mock.client.updatePostBody).not.toHaveBeenCalled();
  });

  it('maps a WordPress 404 to 404 on save', async () => {
    mock.client.updatePostBody.mockRejectedValue(new WpRequestError(404, '/wp/v2/posts/7', 'missing'));
    const res = await call('POST', '/api/posts/7', {
      headers: JSON_H,
      body: JSON.stringify({ content: '<p>x</p>' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a non-JSON content type (415)', async () => {
    const res = await call('POST', '/api/posts/7', { body: JSON.stringify({ content: '' }) });
    expect(res.status).toBe(415);
  });

  it('rejects an invalid body payload (missing content) with 400', async () => {
    const res = await call('POST', '/api/posts/7', {
      headers: JSON_H,
      body: JSON.stringify({ markdown: '# x' }),
    });
    expect(res.status).toBe(400);
    expect(mock.client.updatePostBody).not.toHaveBeenCalled();
  });

  it('rejects an invalid post type with 400', async () => {
    const res = await call('POST', '/api/posts/7', {
      headers: JSON_H,
      body: JSON.stringify({ content: '', type: 'bad type' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 when not connected', async () => {
    state.credentials = null;
    const res = await call('POST', '/api/posts/7', {
      headers: JSON_H,
      body: JSON.stringify({ content: '' }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects an unsupported method (405)', async () => {
    const res = await call('PUT', '/api/posts/7');
    expect(res.status).toBe(405);
  });
});

describe('posts batch route', () => {
  it('applies updates and reports per-row success', async () => {
    mock.client.updatePost.mockResolvedValue({ id: 1 });
    const res = await call('POST', '/api/posts/batch', {
      headers: JSON_H,
      body: JSON.stringify({ type: 'posts', updates: [{ id: 1, title: 'A' }] }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ results: [{ id: 1, ok: true }] });
    expect(mock.client.updatePost).toHaveBeenCalledWith(1, { title: 'A' }, 'posts', undefined);
  });

  it('reports a per-row failure without failing the batch', async () => {
    mock.client.updatePost
      .mockResolvedValueOnce({ id: 1 })
      .mockRejectedValueOnce(new Error('boom'));
    const res = await call('POST', '/api/posts/batch', {
      headers: JSON_H,
      body: JSON.stringify({ type: 'posts', updates: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] }),
    });
    expect(res.status).toBe(200);
    const { results } = JSON.parse(res.body) as { results: { id: number; ok: boolean }[] };
    expect(results).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: false, error: 'boom' },
    ]);
  });

  it('rejects a non-JSON content type (415)', async () => {
    const res = await call('POST', '/api/posts/batch', { body: '{}' });
    expect(res.status).toBe(415);
  });

  it('returns 409 when not connected', async () => {
    state.credentials = null;
    const res = await call('POST', '/api/posts/batch', {
      headers: JSON_H,
      body: JSON.stringify({ type: 'posts', updates: [{ id: 1, title: 'A' }] }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid updates payload (400)', async () => {
    const res = await call('POST', '/api/posts/batch', {
      headers: JSON_H,
      body: JSON.stringify({ type: 'posts', updates: [] }),
    });
    expect(res.status).toBe(400);
    expect(mock.client.updatePost).not.toHaveBeenCalled();
  });

  it('rejects an invalid post type (400)', async () => {
    const res = await call('POST', '/api/posts/batch', {
      headers: JSON_H,
      body: JSON.stringify({ type: 'bad type', updates: [{ id: 1, title: 'A' }] }),
    });
    expect(res.status).toBe(400);
  });

  // The MAX_BODY_BYTES guard (readJsonBody) is deliberately not exercised here: on an oversized
  // body the server destroys the request socket, so the client races between receiving the 400 and
  // a socket hang-up — not a deterministic integration assertion. The size logic is simple and unit-
  // testable separately if needed.

  it('rejects a non-POST method (405)', async () => {
    const res = await call('GET', '/api/posts/batch');
    expect(res.status).toBe(405);
  });
});

describe('posts import route', () => {
  it('creates posts and reports the new id per row', async () => {
    mock.client.createPost.mockResolvedValue({ id: 42 });
    const res = await call('POST', '/api/posts/import', {
      headers: JSON_H,
      body: JSON.stringify({ type: 'posts', creates: [{ title: 'New' }] }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ results: [{ index: 0, ok: true, id: 42 }] });
    expect(mock.client.createPost).toHaveBeenCalledWith({ title: 'New' }, 'posts', undefined);
  });

  it('reports a per-row failure without failing the import', async () => {
    mock.client.createPost
      .mockResolvedValueOnce({ id: 42 })
      .mockRejectedValueOnce(new Error('boom'));
    const res = await call('POST', '/api/posts/import', {
      headers: JSON_H,
      body: JSON.stringify({ type: 'posts', creates: [{ title: 'A' }, { title: 'B' }] }),
    });
    expect(res.status).toBe(200);
    const { results } = JSON.parse(res.body) as { results: { index: number; ok: boolean }[] };
    expect(results).toEqual([
      { index: 0, ok: true, id: 42 },
      { index: 1, ok: false, error: 'boom' },
    ]);
  });

  it('rejects a non-JSON content type (415)', async () => {
    const res = await call('POST', '/api/posts/import', { body: '{}' });
    expect(res.status).toBe(415);
  });

  it('returns 409 when not connected', async () => {
    state.credentials = null;
    const res = await call('POST', '/api/posts/import', {
      headers: JSON_H,
      body: JSON.stringify({ type: 'posts', creates: [{ title: 'A' }] }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid import payload (400)', async () => {
    const res = await call('POST', '/api/posts/import', {
      headers: JSON_H,
      body: JSON.stringify({ type: 'posts', creates: [] }),
    });
    expect(res.status).toBe(400);
    expect(mock.client.createPost).not.toHaveBeenCalled();
  });

  it('rejects an invalid post type (400)', async () => {
    const res = await call('POST', '/api/posts/import', {
      headers: JSON_H,
      body: JSON.stringify({ type: 'bad type', creates: [{ title: 'A' }] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-POST method (405)', async () => {
    const res = await call('GET', '/api/posts/import');
    expect(res.status).toBe(405);
  });
});

describe('meta delete route', () => {
  it('deletes meta keys, forwarding id + keys', async () => {
    // DeleteMetaResult is { postId, deleted } — the route echoes the client result verbatim.
    mock.client.deletePostMeta.mockResolvedValue({ postId: 5, deleted: ['k'] });
    const res = await call('DELETE', '/api/posts/meta', {
      headers: JSON_H,
      body: JSON.stringify({ id: 5, keys: ['k'] }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ postId: 5, deleted: ['k'] });
    expect(mock.client.deletePostMeta).toHaveBeenCalledWith(5, ['k']);
  });

  it('maps a connector-missing 404 to a 409 with a plugin-required message', async () => {
    mock.client.deletePostMeta.mockRejectedValue(
      new WpRequestError(404, '/dbp-wp/v1/posts/5/meta', 'no route'),
    );
    const res = await call('DELETE', '/api/posts/meta', {
      headers: JSON_H,
      body: JSON.stringify({ id: 5, keys: ['k'] }),
    });
    expect(res.status).toBe(409);
    expect(String((JSON.parse(res.body) as { error: string }).error)).toMatch(/companion plugin/i);
  });

  it('surfaces a generic failure as 502', async () => {
    mock.client.deletePostMeta.mockRejectedValue(new Error('boom'));
    const res = await call('DELETE', '/api/posts/meta', {
      headers: JSON_H,
      body: JSON.stringify({ id: 5, keys: ['k'] }),
    });
    expectJsonError(res, 502);
  });

  it('rejects a non-JSON content type (415)', async () => {
    const res = await call('DELETE', '/api/posts/meta', { body: '{}' });
    expect(res.status).toBe(415);
  });

  it('returns 409 when not connected', async () => {
    state.credentials = null;
    const res = await call('DELETE', '/api/posts/meta', {
      headers: JSON_H,
      body: JSON.stringify({ id: 5, keys: ['k'] }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid payload (400)', async () => {
    const res = await call('DELETE', '/api/posts/meta', {
      headers: JSON_H,
      body: JSON.stringify({ id: 5, keys: [] }),
    });
    expect(res.status).toBe(400);
    expect(mock.client.deletePostMeta).not.toHaveBeenCalled();
  });

  it('rejects a non-DELETE method (405)', async () => {
    const res = await call('POST', '/api/posts/meta', { headers: JSON_H, body: '{}' });
    expect(res.status).toBe(405);
  });
});

describe('bulk meta delete route', () => {
  it('deletes meta per post and reports per-row success', async () => {
    mock.client.deletePostMeta.mockResolvedValue({ id: 5, deleted: ['k'] });
    const res = await call('DELETE', '/api/posts/meta/bulk', {
      headers: JSON_H,
      body: JSON.stringify({ deletes: [{ id: 5, keys: ['k'] }] }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ results: [{ id: 5, ok: true }] });
    expect(mock.client.deletePostMeta).toHaveBeenCalledWith(5, ['k']);
  });

  it('reports a connector-missing 404 as a per-row plugin-not-found error', async () => {
    mock.client.deletePostMeta.mockRejectedValue(
      new WpRequestError(404, '/dbp-wp/v1/posts/5/meta', 'no route'),
    );
    const res = await call('DELETE', '/api/posts/meta/bulk', {
      headers: JSON_H,
      body: JSON.stringify({ deletes: [{ id: 5, keys: ['k'] }] }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      results: [{ id: 5, ok: false, error: 'Companion plugin not found.' }],
    });
  });

  it('rejects a non-JSON content type (415)', async () => {
    const res = await call('DELETE', '/api/posts/meta/bulk', { body: '{}' });
    expect(res.status).toBe(415);
  });

  it('rejects an invalid payload (400)', async () => {
    const res = await call('DELETE', '/api/posts/meta/bulk', {
      headers: JSON_H,
      body: JSON.stringify({ deletes: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-DELETE method (405)', async () => {
    const res = await call('POST', '/api/posts/meta/bulk', { headers: JSON_H, body: '{}' });
    expect(res.status).toBe(405);
  });
});

describe('relation route', () => {
  it('sets a relation when the connector is available', async () => {
    mock.client.detectConnector.mockResolvedValue(true);
    mock.client.setRelation.mockResolvedValue({ id: 2 });
    const res = await call('POST', '/api/relation', {
      headers: JSON_H,
      body: JSON.stringify({ childId: 2, childType: 'posts', parentId: 1, parentType: 'posts' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ post: { id: 2 } });
    expect(mock.client.setRelation).toHaveBeenCalledWith(2, 'posts', {
      parentId: 1,
      parentType: 'posts',
    });
  });

  it('clears a relation when parentId is null', async () => {
    mock.client.detectConnector.mockResolvedValue(true);
    mock.client.clearRelation.mockResolvedValue({ id: 2 });
    const res = await call('POST', '/api/relation', {
      headers: JSON_H,
      body: JSON.stringify({ childId: 2, childType: 'posts', parentId: null }),
    });
    expect(res.status).toBe(200);
    expect(mock.client.clearRelation).toHaveBeenCalledWith(2, 'posts');
    expect(mock.client.setRelation).not.toHaveBeenCalled();
  });

  it('refuses with 409 when the connector is absent (before reading the body)', async () => {
    mock.client.detectConnector.mockResolvedValue(false);
    const res = await call('POST', '/api/relation', {
      headers: JSON_H,
      body: JSON.stringify({ childId: 2, parentId: 1, parentType: 'posts' }),
    });
    expect(res.status).toBe(409);
    expect(String((JSON.parse(res.body) as { error: string }).error)).toMatch(/companion plugin/i);
    expect(mock.client.setRelation).not.toHaveBeenCalled();
  });

  it('maps a RelationError to 400 (caller fault)', async () => {
    mock.client.detectConnector.mockResolvedValue(true);
    mock.client.setRelation.mockRejectedValue(new RelationError('self-parent not allowed'));
    const res = await call('POST', '/api/relation', {
      headers: JSON_H,
      body: JSON.stringify({ childId: 2, childType: 'posts', parentId: 1, parentType: 'posts' }),
    });
    expect(res.status).toBe(400);
  });

  it('surfaces a generic failure as 502', async () => {
    mock.client.detectConnector.mockResolvedValue(true);
    mock.client.setRelation.mockRejectedValue(new Error('boom'));
    const res = await call('POST', '/api/relation', {
      headers: JSON_H,
      body: JSON.stringify({ childId: 2, childType: 'posts', parentId: 1, parentType: 'posts' }),
    });
    expectJsonError(res, 502);
  });

  it('rejects a non-JSON content type (415)', async () => {
    const res = await call('POST', '/api/relation', { body: '{}' });
    expect(res.status).toBe(415);
  });

  it('returns 409 when not connected', async () => {
    state.credentials = null;
    const res = await call('POST', '/api/relation', {
      headers: JSON_H,
      body: JSON.stringify({ childId: 2, parentId: 1, parentType: 'posts' }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid relation payload (400)', async () => {
    mock.client.detectConnector.mockResolvedValue(true);
    const res = await call('POST', '/api/relation', {
      headers: JSON_H,
      body: JSON.stringify({ childId: 0 }),
    });
    expect(res.status).toBe(400);
    expect(mock.client.setRelation).not.toHaveBeenCalled();
  });

  it('rejects a non-POST method (405)', async () => {
    const res = await call('GET', '/api/relation');
    expect(res.status).toBe(405);
  });
});

describe('media route', () => {
  const UPLOAD_H = { 'x-dbp-filename': encodeURIComponent('photo.png'), 'content-type': 'image/png' };

  it('uploads an image, forwarding the bytes, filename and mime type', async () => {
    // WpMedia is camelCase (sourceUrl, …); the route sends the normalized item verbatim.
    mock.client.uploadMedia.mockResolvedValue({ id: 9, sourceUrl: 'https://x/photo.png' });
    const res = await call('POST', '/api/media', { headers: UPLOAD_H, body: 'PNGDATA' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ media: { id: 9, sourceUrl: 'https://x/photo.png' } });
    const [bytes, filename, mime] = mock.client.uploadMedia.mock.calls[0] as [Buffer, string, string];
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString('utf8')).toBe('PNGDATA');
    expect(filename).toBe('photo.png');
    expect(mime).toBe('image/png');
  });

  it('rejects an upload with no X-DBP-Filename header (400)', async () => {
    const res = await call('POST', '/api/media', { headers: { 'content-type': 'image/png' }, body: 'X' });
    expect(res.status).toBe(400);
    expect(mock.client.uploadMedia).not.toHaveBeenCalled();
  });

  it('returns 409 when uploading while not connected', async () => {
    state.credentials = null;
    const res = await call('POST', '/api/media', { headers: UPLOAD_H, body: 'X' });
    expect(res.status).toBe(409);
  });

  it('rejects an empty upload (400)', async () => {
    const res = await call('POST', '/api/media', { headers: UPLOAD_H, body: '' });
    expect(res.status).toBe(400);
    expect(mock.client.uploadMedia).not.toHaveBeenCalled();
  });

  it('surfaces an upload failure as 502', async () => {
    mock.client.uploadMedia.mockRejectedValue(new Error('upstream'));
    const res = await call('POST', '/api/media', { headers: UPLOAD_H, body: 'X' });
    expectJsonError(res, 502);
  });

  it('lists media, returning items + totalPages', async () => {
    mock.client.listMedia.mockResolvedValue({ items: [{ id: 1 }], totalPages: 3 });
    const res = await call('GET', '/api/media?page=2&search=cat');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [{ id: 1 }], totalPages: 3 });
    expect(mock.client.listMedia).toHaveBeenCalledWith({ page: 2, search: 'cat' });
  });

  it('resolves specific ids via ?include=', async () => {
    mock.client.resolveMedia.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const res = await call('GET', '/api/media?include=1,2');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [{ id: 1 }, { id: 2 }] });
    expect(mock.client.resolveMedia).toHaveBeenCalledWith([1, 2]);
  });

  it('returns an unconfigured marker when listing while not connected', async () => {
    state.credentials = null;
    const res = await call('GET', '/api/media');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [], totalPages: 1, unconfigured: true });
  });

  it('surfaces a list failure as 502', async () => {
    mock.client.listMedia.mockRejectedValue(new Error('upstream'));
    const res = await call('GET', '/api/media');
    expectJsonError(res, 502);
  });

  it('rejects an unsupported method (405)', async () => {
    const res = await call('PUT', '/api/media');
    expect(res.status).toBe(405);
  });
});

describe('taxonomies route', () => {
  it('lists taxonomies, forwarding the type filter', async () => {
    // A full WpTaxonomy, asserted verbatim (the route passes the client result straight through),
    // so a dropped/renamed field is caught rather than only the array length.
    const taxonomy = {
      slug: 'category',
      restBase: 'categories',
      name: 'Categories',
      hierarchical: true,
      types: ['post'],
    };
    mock.client.listTaxonomies.mockResolvedValue([taxonomy]);
    const res = await call('GET', '/api/taxonomies?type=post');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ taxonomies: [taxonomy] });
    expect(mock.client.listTaxonomies).toHaveBeenCalledWith('post');
  });

  it('rejects an invalid post type (400)', async () => {
    const res = await call('GET', '/api/taxonomies?type=bad%20type');
    expect(res.status).toBe(400);
    expect(mock.client.listTaxonomies).not.toHaveBeenCalled();
  });

  it('returns an empty list when not connected', async () => {
    state.credentials = null;
    const res = await call('GET', '/api/taxonomies');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ taxonomies: [] });
  });

  it('surfaces an upstream failure as 502', async () => {
    mock.client.listTaxonomies.mockRejectedValue(new Error('upstream'));
    const res = await call('GET', '/api/taxonomies');
    expectJsonError(res, 502);
  });

  it('rejects a non-GET method (405)', async () => {
    const res = await call('POST', '/api/taxonomies', { headers: JSON_H, body: '{}' });
    expect(res.status).toBe(405);
  });
});

describe('terms route — GET (list / resolve / all)', () => {
  it('lists terms, forwarding page + search', async () => {
    mock.client.listTerms.mockResolvedValue({ items: [{ id: 1 }], totalPages: 2 });
    const res = await call('GET', '/api/terms?taxonomy=categories&page=2&search=foo');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [{ id: 1 }], totalPages: 2 });
    expect(mock.client.listTerms).toHaveBeenCalledWith('categories', { page: 2, search: 'foo' });
  });

  it('resolves specific ids via ?include=', async () => {
    mock.client.resolveTerms.mockResolvedValue([{ id: 1 }]);
    const res = await call('GET', '/api/terms?taxonomy=categories&include=1,2');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [{ id: 1 }] });
    expect(mock.client.resolveTerms).toHaveBeenCalledWith('categories', [1, 2]);
  });

  it('fetches every term via ?all=1, returning the truncated flag', async () => {
    mock.client.listAllTerms.mockResolvedValue({ items: [{ id: 1 }], truncated: true });
    const res = await call('GET', '/api/terms?taxonomy=categories&all=1');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [{ id: 1 }], truncated: true });
    expect(mock.client.listAllTerms).toHaveBeenCalledWith('categories', {});
  });

  it('rejects a missing/invalid taxonomy (400)', async () => {
    const res = await call('GET', '/api/terms');
    expect(res.status).toBe(400);
    expect(mock.client.listTerms).not.toHaveBeenCalled();
  });

  it('returns an empty list when not connected', async () => {
    state.credentials = null;
    const res = await call('GET', '/api/terms?taxonomy=categories');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [], totalPages: 1 });
  });

  it('surfaces an upstream failure as 502', async () => {
    mock.client.listTerms.mockRejectedValue(new Error('upstream'));
    const res = await call('GET', '/api/terms?taxonomy=categories');
    expectJsonError(res, 502);
  });
});

describe('connection route', () => {
  it('GET reports the connected state and probes the connector', async () => {
    mock.client.detectConnector.mockResolvedValue(true);
    const res = await call('GET', '/api/connection');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      connected: true,
      siteUrl: 'https://example.com',
      connectorAvailable: true,
      canPersist: false,
      persisted: false,
    });
    expect(mock.client.detectConnector).toHaveBeenCalledTimes(1);
  });

  it('GET reports the disconnected state without probing', async () => {
    state.credentials = null;
    const res = await call('GET', '/api/connection');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ connected: false, siteUrl: null });
    expect(mock.client.detectConnector).not.toHaveBeenCalled();
  });

  it('GET surfaces a saved (persisted) connection when the store has one', async () => {
    state.credentials = null;
    store.isAvailable.mockReturnValue(true);
    store.peek.mockResolvedValue({ siteUrl: 'https://saved.example', username: 'u' });
    const res = await call('GET', '/api/connection');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      connected: false,
      canPersist: true,
      persisted: true,
      savedSiteUrl: 'https://saved.example',
    });
  });

  it('POST connects with valid credentials, probing via listPosts', async () => {
    mock.client.listPosts.mockResolvedValue([]);
    mock.client.detectConnector.mockResolvedValue(false);
    const res = await call('POST', '/api/connection', {
      headers: JSON_H,
      body: JSON.stringify({ siteUrl: 'https://x.example', username: 'u', applicationPassword: 'p' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ connected: true, siteUrl: 'https://x.example' });
    expect(mock.client.listPosts).toHaveBeenCalledWith({ perPage: 1 });
    // The probe must use the submitted credentials (the mock ignores ctor args, so assert them).
    expect(vi.mocked(WpClient)).toHaveBeenCalledWith({
      siteUrl: 'https://x.example',
      username: 'u',
      applicationPassword: 'p',
    });
    expect(state.credentials?.siteUrl).toBe('https://x.example');
  });

  it('POST maps an auth failure to 502 with a fixed message (no upstream echo)', async () => {
    mock.client.listPosts.mockRejectedValue(new WpRequestError(401, '/wp/v2/posts', 'nope'));
    const res = await call('POST', '/api/connection', {
      headers: JSON_H,
      body: JSON.stringify({ siteUrl: 'https://x.example', username: 'u', applicationPassword: 'p' }),
    });
    expectJsonError(res, 502);
    expect(String((JSON.parse(res.body) as { error: string }).error)).toMatch(/authentication failed/i);
  });

  it('POST maps a non-auth probe failure to 502 with the connect-failed message', async () => {
    mock.client.listPosts.mockRejectedValue(new WpRequestError(500, '/wp/v2/posts', 'boom'));
    const res = await call('POST', '/api/connection', {
      headers: JSON_H,
      body: JSON.stringify({ siteUrl: 'https://x.example', username: 'u', applicationPassword: 'p' }),
    });
    expectJsonError(res, 502);
    expect(String((JSON.parse(res.body) as { error: string }).error)).toMatch(/could not connect/i);
  });

  it('POST persists when remember=true and the store is available', async () => {
    mock.client.listPosts.mockResolvedValue([]);
    mock.client.detectConnector.mockResolvedValue(false);
    store.isAvailable.mockReturnValue(true);
    const res = await call('POST', '/api/connection', {
      headers: JSON_H,
      body: JSON.stringify({
        siteUrl: 'https://x.example',
        username: 'u',
        applicationPassword: 'p',
        remember: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ persisted: true });
    expect(store.save).toHaveBeenCalledWith({
      siteUrl: 'https://x.example',
      username: 'u',
      applicationPassword: 'p',
    });
  });

  it('POST with useSaved loads credentials from the store', async () => {
    store.isAvailable.mockReturnValue(true);
    store.load.mockResolvedValue({ siteUrl: 'https://saved.example', username: 'u', applicationPassword: 'p' });
    mock.client.listPosts.mockResolvedValue([]);
    mock.client.detectConnector.mockResolvedValue(false);
    const res = await call('POST', '/api/connection', {
      headers: JSON_H,
      body: JSON.stringify({ useSaved: true }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ connected: true, siteUrl: 'https://saved.example' });
    expect(store.load).toHaveBeenCalled();
  });

  it('POST rejects missing credential fields (400)', async () => {
    const res = await call('POST', '/api/connection', {
      headers: JSON_H,
      body: JSON.stringify({ siteUrl: 'https://x.example' }),
    });
    expect(res.status).toBe(400);
    expect(mock.client.listPosts).not.toHaveBeenCalled();
  });

  it('POST maps a WpClient constructor throw (bad site URL) to 400', async () => {
    vi.mocked(WpClient).mockImplementationOnce(() => {
      throw new Error('Invalid site URL');
    });
    const res = await call('POST', '/api/connection', {
      headers: JSON_H,
      body: JSON.stringify({ siteUrl: 'http://[bad', username: 'u', applicationPassword: 'p' }),
    });
    expect(res.status).toBe(400);
    // Prove the one-shot throw was consumed (it constructs WpClient), so it can't bleed into the
    // next test — vi.clearAllMocks() clears call history but not a queued mockImplementationOnce.
    expect(vi.mocked(WpClient)).toHaveBeenCalledTimes(1);
  });

  it('POST rejects a non-JSON content type (415)', async () => {
    const res = await call('POST', '/api/connection', { body: '{}' });
    expect(res.status).toBe(415);
  });

  it('DELETE disconnects but keeps the saved credentials by default', async () => {
    const res = await call('DELETE', '/api/connection');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ connected: false });
    expect(state.credentials).toBeNull();
    expect(store.clear).not.toHaveBeenCalled();
  });

  it('DELETE with ?forget=1 also clears the saved credentials', async () => {
    const res = await call('DELETE', '/api/connection?forget=1');
    expect(res.status).toBe(200);
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsupported method (405)', async () => {
    const res = await call('PUT', '/api/connection');
    expect(res.status).toBe(405);
  });
});

describe('unknown api route', () => {
  it('returns 404 for an unrecognized /api path', async () => {
    const res = await call('GET', '/api/nope');
    expect(res.status).toBe(404);
  });
});
