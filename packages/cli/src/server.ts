import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';
import { WpClient, WpRequestError, type WpCredentials } from '@dbp-wp/core';
import { parseCredentialsInput } from './config';
import { isAllowedHost, isCrossSiteRequest, isJsonContentType } from './host';
import {
  parseBatchUpdates,
  parseBulkMetaDelete,
  parseMetaDelete,
  parsePostTypeSlug,
} from './updates';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const MAX_BODY_BYTES = 1_000_000;

/** Mutable connection state, held in memory only (never written to disk). */
export interface ConnectionState {
  credentials: WpCredentials | null;
  /**
   * Whether the companion plugin is active on the connected site. `null` until first
   * detected (e.g. an env-seeded connection that has not been probed yet).
   */
  connectorAvailable: boolean | null;
}

export interface ServerOptions {
  state: ConnectionState;
  /** Absolute path to the built UI `dist` directory, or null when not built. */
  uiDir: string | null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  res.end(message);
}

/** Read and JSON-parse a request body, rejecting bodies over the size limit. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (!text) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function handlePosts(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
): Promise<void> {
  try {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const credentials = options.state.credentials;
    if (!credentials) {
      sendJson(res, 200, { posts: [], unconfigured: true });
      return;
    }
    const client = new WpClient(credentials);
    const type = url.searchParams.get('type');
    const pageRaw = url.searchParams.get('page');
    const page = pageRaw ? Number.parseInt(pageRaw, 10) : undefined;
    const posts = await client.listPosts({
      ...(type ? { type } : {}),
      ...(page && page > 0 ? { page } : {}),
    });
    sendJson(res, 200, { posts, unconfigured: false });
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: e instanceof Error ? e.message : 'Upstream request failed' });
    }
  }
}

async function handleTypes(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  const credentials = options.state.credentials;
  if (!credentials) {
    sendJson(res, 200, { types: [] });
    return;
  }
  try {
    const types = await new WpClient(credentials).listPostTypes();
    sendJson(res, 200, { types });
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: e instanceof Error ? e.message : 'Upstream request failed' });
    }
  }
}

async function handlePostsBatch(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    sendJson(res, 415, { error: 'Content-Type must be application/json.' });
    return;
  }
  const credentials = options.state.credentials;
  if (!credentials) {
    sendJson(res, 409, { error: 'Not connected' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : 'Invalid request body' });
    return;
  }
  const updates = parseBatchUpdates(body);
  if (!updates) {
    sendJson(res, 400, { error: 'Invalid updates payload.' });
    return;
  }
  const type = parsePostTypeSlug((body as Record<string, unknown>).type);
  if (type === null) {
    sendJson(res, 400, { error: 'Invalid post type.' });
    return;
  }

  // Apply sequentially; report success/failure per row rather than failing the batch.
  // The whole batch targets one post type (the slug threaded from the UI's selector).
  const client = new WpClient(credentials);
  const results: Array<{ id: number; ok: boolean; error?: string }> = [];
  for (const update of updates) {
    try {
      // Standard fields and connector meta ride a single request per row.
      await client.updatePost(update.id, update.fields, type, update.meta);
      results.push({ id: update.id, ok: true });
    } catch (e) {
      results.push({ id: update.id, ok: false, error: e instanceof Error ? e.message : 'Update failed' });
    }
  }
  sendJson(res, 200, { results });
}

async function handleMetaDelete(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  if (req.method !== 'DELETE') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    sendJson(res, 415, { error: 'Content-Type must be application/json.' });
    return;
  }
  const credentials = options.state.credentials;
  if (!credentials) {
    sendJson(res, 409, { error: 'Not connected' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : 'Invalid request body' });
    return;
  }
  const request = parseMetaDelete(body);
  if (!request) {
    sendJson(res, 400, { error: 'Invalid meta-delete payload.' });
    return;
  }

  try {
    const client = new WpClient(credentials);
    const result = await client.deletePostMeta(request.id, request.keys);
    sendJson(res, 200, result);
  } catch (e) {
    if (!res.headersSent) {
      if (e instanceof WpRequestError && e.status === 404) {
        // A 404 on the connector route means the companion plugin is not active.
        sendJson(res, 409, {
          error: 'The companion plugin is required to delete meta, but it was not found on the site.',
        });
      } else {
        sendJson(res, 502, { error: e instanceof Error ? e.message : 'Meta delete failed' });
      }
    }
  }
}

async function handleBulkMetaDelete(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  if (req.method !== 'DELETE') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    sendJson(res, 415, { error: 'Content-Type must be application/json.' });
    return;
  }
  const credentials = options.state.credentials;
  if (!credentials) {
    sendJson(res, 409, { error: 'Not connected' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : 'Invalid request body' });
    return;
  }
  const deletes = parseBulkMetaDelete(body);
  if (!deletes) {
    sendJson(res, 400, { error: 'Invalid bulk meta-delete payload.' });
    return;
  }

  // Apply sequentially; report success/failure per post rather than failing the batch.
  const client = new WpClient(credentials);
  const results: Array<{ id: number; ok: boolean; error?: string }> = [];
  for (const del of deletes) {
    try {
      await client.deletePostMeta(del.id, del.keys);
      results.push({ id: del.id, ok: true });
    } catch (e) {
      const error =
        e instanceof WpRequestError && e.status === 404
          ? 'Companion plugin not found.'
          : e instanceof Error
            ? e.message
            : 'Delete failed';
      results.push({ id: del.id, ok: false, error });
    }
  }
  sendJson(res, 200, { results });
}

async function handleConnection(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  if (req.method === 'GET') {
    const c = options.state.credentials;
    // Lazily detect the connector for connections that were never probed (e.g. seeded
    // from env vars), caching the result so we only hit the REST index once. Concurrent
    // first requests may probe more than once (benign; detection is deterministic), and a
    // transient probe failure caches restricted mode until the next reconnect.
    if (c && options.state.connectorAvailable === null) {
      try {
        options.state.connectorAvailable = await new WpClient(c).detectConnector();
      } catch {
        options.state.connectorAvailable = false;
      }
    }
    sendJson(res, 200, {
      connected: c !== null,
      siteUrl: c?.siteUrl ?? null,
      connectorAvailable: options.state.connectorAvailable ?? false,
    });
    return;
  }

  if (req.method === 'DELETE') {
    options.state.credentials = null;
    options.state.connectorAvailable = null;
    sendJson(res, 200, { connected: false, siteUrl: null, connectorAvailable: false });
    return;
  }

  if (req.method === 'POST') {
    if (!isJsonContentType(req.headers['content-type'])) {
      sendJson(res, 415, { error: 'Content-Type must be application/json.' });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Invalid request body' });
      return;
    }
    const credentials = parseCredentialsInput(body);
    if (!credentials) {
      sendJson(res, 400, {
        error: 'siteUrl, username, and applicationPassword are required.',
      });
      return;
    }
    let client: WpClient;
    try {
      client = new WpClient(credentials);
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Invalid site URL' });
      return;
    }
    try {
      // Probe the connection so bad credentials fail here, not on first use.
      await client.listPosts({ perPage: 1 });
    } catch (e) {
      // Return a fixed message rather than echoing raw upstream details.
      const status = e instanceof WpRequestError ? e.status : 0;
      const message =
        status === 401 || status === 403
          ? 'Authentication failed. Check the username and Application Password.'
          : 'Could not connect to the WordPress REST API. Check the site URL.';
      sendJson(res, 502, { error: message });
      return;
    }
    options.state.credentials = credentials;
    // Detect the companion plugin; absence is not a connection failure (restricted mode).
    try {
      options.state.connectorAvailable = await client.detectConnector();
    } catch {
      options.state.connectorAvailable = false;
    }
    sendJson(res, 200, {
      connected: true,
      siteUrl: credentials.siteUrl,
      connectorAvailable: options.state.connectorAvailable,
    });
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

async function handleApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
): Promise<void> {
  if (url.pathname === '/api/connection') {
    await handleConnection(req, res, options);
    return;
  }
  if (url.pathname === '/api/types') {
    await handleTypes(req, res, options);
    return;
  }
  if (url.pathname === '/api/posts/batch') {
    await handlePostsBatch(req, res, options);
    return;
  }
  if (url.pathname === '/api/posts/meta/bulk') {
    await handleBulkMetaDelete(req, res, options);
    return;
  }
  if (url.pathname === '/api/posts/meta') {
    await handleMetaDelete(req, res, options);
    return;
  }
  if (url.pathname === '/api/posts') {
    await handlePosts(req, res, url, options);
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

/** Resolve a request path to a file inside uiDir, or null if it escapes the root. */
function resolveSafe(uiDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = resolve(uiDir, '.' + (decoded === '/' ? '/index.html' : decoded));
  const rel = relative(uiDir, candidate);
  if (rel === '') {
    return join(uiDir, 'index.html');
  }
  if (rel.startsWith('..') || resolve(uiDir, rel) !== candidate) {
    return null;
  }
  return candidate;
}

/** Stream a file to the response with an error handler so failures never crash. */
function pipeFile(res: ServerResponse, filePath: string, contentType: string): void {
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    } else {
      res.destroy();
    }
  });
  res.writeHead(200, { 'Content-Type': contentType });
  stream.pipe(res);
}

async function serveStatic(
  res: ServerResponse,
  uiDir: string | null,
  pathname: string,
): Promise<void> {
  if (!uiDir) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(notBuiltPage());
    return;
  }

  const filePath = resolveSafe(uiDir, pathname);
  if (!filePath) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  if (await statFile(filePath)) {
    pipeFile(res, filePath, MIME[extname(filePath)] ?? 'application/octet-stream');
    return;
  }

  // SPA fallback: serve index.html for extension-less routes; otherwise 404.
  if (extname(pathname) === '') {
    const indexPath = join(uiDir, 'index.html');
    if (await statFile(indexPath)) {
      pipeFile(res, indexPath, 'text/html; charset=utf-8');
      return;
    }
  }
  sendError(res, 404, 'Not found');
}

async function statFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function notBuiltPage(): string {
  return [
    '<!doctype html><meta charset="utf-8"><title>DBP WP</title>',
    '<body style="font-family:system-ui;padding:2rem">',
    '<h1>DBP WP</h1>',
    '<p>The UI has not been built yet. Run <code>npm run build</code> and restart.</p>',
    '</body>',
  ].join('');
}

/** Create the local HTTP server: serves the UI and a small JSON API. */
export function createDbpServer(options: ServerOptions): Server {
  return createServer((req, res) => {
    // Reject non-loopback Host headers (DNS rebinding protection).
    if (!isAllowedHost(req.headers.host)) {
      sendError(res, 403, 'Forbidden');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // Block cross-site browser requests to the API (CSRF / outbound-probe abuse).
      if (isCrossSiteRequest(req.headers['sec-fetch-site'])) {
        sendError(res, 403, 'Forbidden');
        return;
      }
      void handleApiRoutes(req, res, url, options).catch(() =>
        sendError(res, 500, 'Internal error'),
      );
      return;
    }
    void serveStatic(res, options.uiDir, url.pathname).catch(() =>
      sendError(res, 500, 'Internal error'),
    );
  });
}
