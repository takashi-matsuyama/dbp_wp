import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration tests for the cli HTTP server: a real ephemeral server, driven over node:http (which,
// unlike fetch, lets us set the forbidden Host / Sec-Fetch-Site headers the security guards inspect).
// The upstream WordPress client is mocked, so no network and the route plumbing is what's exercised.

// The mock WordPress client: only the methods the routes under test call. Each is a vi.fn so a
// test can set its resolved value or implementation.
interface MockClient {
  listPostTypes: ReturnType<typeof vi.fn>;
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

import { WpRequestError, type WpCredentials } from '@dbp-wp/core';
import type { CredentialsStore } from './credentials-store';
import { createDbpServer, type ConnectionState } from './server';

const CREDS: WpCredentials = {
  siteUrl: 'https://example.com',
  username: 'u',
  applicationPassword: 'p',
};

// A no-op credential store: the routes under test never persist.
const store: CredentialsStore = {
  isAvailable: () => false,
  load: () => Promise.resolve(null),
  save: () => Promise.resolve(),
  clear: () => Promise.resolve(),
  peek: () => Promise.resolve(null),
};

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
    createTerm: vi.fn(),
    updateTerm: vi.fn(),
    deleteTerm: vi.fn(),
    mergeTerm: vi.fn(),
  };
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
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: opts.headers },
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
});
