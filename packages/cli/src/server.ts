import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';
import { RelationError, WpClient, WpRequestError, type WpCredentials } from '@dbp-wp/core';
import { parseCredentialsInput, parseRememberFlag, parseUseSaved } from './config';
import type { CredentialsStore } from './credentials-store';
import { isAllowedHost, isCrossSiteRequest, isJsonContentType } from './host';
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

/** Upload bodies (binary media) get a larger, separate cap than JSON request bodies. */
const MAX_MEDIA_BYTES = 25_000_000;

/** Matches `/api/posts/<id>` (single-post editor), capturing the numeric id. Digits only,
 *  so it never shadows `/api/posts/batch|import|meta` or the `/api/posts` listing. */
const SINGLE_POST_PATH = /^\/api\/posts\/(\d+)$/;

/** Matches `/api/terms/<id>` (term update/delete in the taxonomy manager), capturing the id.
 *  Digits only, so it never shadows the `/api/terms` list/create endpoint. */
const SINGLE_TERM_PATH = /^\/api\/terms\/(\d+)$/;

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
  /** Opt-in credential persistence (OS secure storage). A no-op on unsupported platforms. */
  store: CredentialsStore;
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

/** Read a raw request body up to `maxBytes`, rejecting (and aborting) when it is exceeded. */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Decode the `X-DBP-Filename` header (sent percent-encoded so non-ASCII filenames survive a
 * header round-trip). Returns null when the header is missing or empty.
 */
function decodeFilenameHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // tolerate a non-encoded header rather than rejecting the upload
  }
}

/**
 * Upload an image to the media library. The browser sends raw file bytes (not JSON), so this
 * route does not use the JSON content-type guard; instead the required `X-DBP-Filename`
 * custom header forces a CORS preflight (which the server never grants), restoring the
 * simple-request CSRF defense. The loopback-Host and Sec-Fetch-Site guards still apply.
 */
async function handleMediaUpload(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  const filename = decodeFilenameHeader(req.headers['x-dbp-filename']);
  if (filename === null) {
    sendJson(res, 400, { error: 'Missing or invalid X-DBP-Filename header.' });
    return;
  }
  const credentials = options.state.credentials;
  if (!credentials) {
    sendJson(res, 409, { error: 'Not connected' });
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await readRawBody(req, MAX_MEDIA_BYTES);
  } catch (e) {
    const tooLarge = e instanceof Error && e.message.includes('too large');
    sendJson(res, tooLarge ? 413 : 400, {
      error: tooLarge ? 'File too large (max 25 MB).' : 'Could not read upload.',
    });
    return;
  }
  if (bytes.length === 0) {
    sendJson(res, 400, { error: 'Empty upload.' });
    return;
  }

  const contentType = req.headers['content-type'];
  const mimeType = typeof contentType === 'string' ? contentType.split(';')[0]?.trim() : undefined;
  try {
    const media = await new WpClient(credentials).uploadMedia(bytes, filename, mimeType);
    sendJson(res, 200, { media });
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: e instanceof Error ? e.message : 'Upload failed' });
    }
  }
}

/**
 * List image attachments for the media picker, or resolve specific ids (`?include=`) to
 * fill featured-image thumbnails. Both are core REST calls (no connector needed).
 */
async function handleMediaList(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
): Promise<void> {
  const credentials = options.state.credentials;
  if (!credentials) {
    sendJson(res, 200, { items: [], totalPages: 1, unconfigured: true });
    return;
  }
  const client = new WpClient(credentials);
  try {
    const include = url.searchParams.get('include');
    if (include !== null) {
      const ids = include
        .split(',')
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n));
      sendJson(res, 200, { items: await client.resolveMedia(ids) });
      return;
    }
    const pageRaw = url.searchParams.get('page');
    const page = pageRaw ? Number.parseInt(pageRaw, 10) : undefined;
    const search = url.searchParams.get('search') ?? undefined;
    const result = await client.listMedia({
      ...(page && page > 0 ? { page } : {}),
      ...(search ? { search } : {}),
    });
    sendJson(res, 200, { items: result.items, totalPages: result.totalPages });
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: e instanceof Error ? e.message : 'Upstream request failed' });
    }
  }
}

/** Dispatch `/api/media`: POST uploads an image, GET lists/resolves the media library. */
async function handleMedia(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
): Promise<void> {
  if (req.method === 'POST') {
    await handleMediaUpload(req, res, options);
    return;
  }
  if (req.method === 'GET') {
    await handleMediaList(req, res, url, options);
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed' });
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

async function handlePrintPosts(
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
      sendJson(res, 200, { records: [], unconfigured: true });
      return;
    }
    const client = new WpClient(credentials);
    const type = url.searchParams.get('type');
    const pageRaw = url.searchParams.get('page');
    const page = pageRaw ? Number.parseInt(pageRaw, 10) : undefined;
    // Print needs content/excerpt + embedded media/terms, so this uses the `_embed`
    // listing rather than the lean table/spreadsheet one.
    const records = await client.listPostsForPrint({
      ...(type ? { type } : {}),
      ...(page && page > 0 ? { page } : {}),
    });
    sendJson(res, 200, { records, unconfigured: false });
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

async function handlePostsImport(
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
  const creates = parseImportCreates(body);
  if (!creates) {
    sendJson(res, 400, { error: 'Invalid import payload.' });
    return;
  }
  const type = parsePostTypeSlug((body as Record<string, unknown>).type);
  if (type === null) {
    sendJson(res, 400, { error: 'Invalid post type.' });
    return;
  }

  // Create sequentially; report success/failure per row (with the new id) rather than
  // failing the whole import. The batch targets one post type (slug from the UI).
  const client = new WpClient(credentials);
  const results: Array<{ index: number; ok: boolean; id?: number; error?: string }> = [];
  for (const [i, create] of creates.entries()) {
    try {
      const post = await client.createPost(create.fields, type, create.meta);
      results.push({ index: i, ok: true, id: post.id });
    } catch (e) {
      results.push({
        index: i,
        ok: false,
        error: e instanceof Error ? e.message : 'Create failed',
      });
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

async function handleRelation(
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

  // Relation meta is registered by the companion plugin; without it WordPress silently
  // ignores the keys, so a write would falsely look successful. Require the connector and
  // surface a clear 409 (probing lazily for connections that were never probed).
  if (!(await ensureConnectorAvailable(options, credentials))) {
    sendJson(res, 409, {
      error: 'The companion plugin is required to edit relations, but it was not found on the site.',
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : 'Invalid request body' });
    return;
  }
  const request = parseRelation(body);
  if (!request) {
    sendJson(res, 400, { error: 'Invalid relation payload.' });
    return;
  }

  try {
    const client = new WpClient(credentials);
    const post = request.relation
      ? await client.setRelation(request.childId, request.childType, request.relation)
      : await client.clearRelation(request.childId, request.childType);
    sendJson(res, 200, { post });
  } catch (e) {
    if (!res.headersSent) {
      // A rejected assignment (bad id/type, self-parent) is the caller's fault → 400.
      if (e instanceof RelationError) {
        sendJson(res, 400, { error: e.message });
      } else {
        sendJson(res, 502, { error: e instanceof Error ? e.message : 'Relation update failed' });
      }
    }
  }
}

/**
 * Lazily detect and cache whether the companion plugin is active, returning the result. Gates
 * operations that write protected meta (which WordPress silently ignores without the connector).
 *
 * A definitive probe (REST index reachable) is cached. A transient probe FAILURE is NOT cached:
 * a network blip would otherwise pin restricted mode until the next reconnect, falsely rejecting
 * connector writes. The state is left unknown so the next request re-probes; the connector is
 * treated as unavailable for this request only.
 */
async function ensureConnectorAvailable(
  options: ServerOptions,
  credentials: WpCredentials,
): Promise<boolean> {
  if (options.state.connectorAvailable === null) {
    try {
      options.state.connectorAvailable = await new WpClient(credentials).detectConnector();
    } catch {
      return false;
    }
  }
  return options.state.connectorAvailable;
}

/**
 * Fetch a single post for the body editor: the raw `content` HTML plus, when the connector
 * registered it, the lossless Markdown source (`_dbp_wp_markdown`). The standard listing omits
 * the body, so the editor uses this dedicated read. Core REST — no connector needed for the
 * HTML body; the Markdown source simply does not come back in restricted mode (HTML-only).
 */
async function handleGetPostForEdit(
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
  id: number,
): Promise<void> {
  const credentials = options.state.credentials;
  if (!credentials) {
    sendJson(res, 409, { error: 'Not connected' });
    return;
  }
  const type = parsePostTypeSlug(url.searchParams.get('type') ?? undefined);
  if (type === null) {
    sendJson(res, 400, { error: 'Invalid post type.' });
    return;
  }
  try {
    const post = await new WpClient(credentials).getPostForEdit(id, type);
    sendJson(res, 200, { post });
  } catch (e) {
    if (!res.headersSent) {
      if (e instanceof WpRequestError && e.status === 404) {
        sendJson(res, 404, { error: 'Post not found.' });
      } else {
        sendJson(res, 502, { error: e instanceof Error ? e.message : 'Upstream request failed' });
      }
    }
  }
}

/**
 * Save a single post's body: writes the `content` HTML and, in Markdown mode, the
 * `_dbp_wp_markdown` source — both in one request. Writing or clearing the Markdown source
 * touches a protected meta key and requires the companion plugin; a content-only (HTML) save
 * does not. The post id comes from the URL; `type` and the body come from the JSON payload.
 */
async function handleSavePostBody(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  id: number,
): Promise<void> {
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
  const save = parseSinglePostSave(body);
  if (!save) {
    sendJson(res, 400, { error: 'Invalid post body payload.' });
    return;
  }
  const type = parsePostTypeSlug((body as Record<string, unknown>).type);
  if (type === null) {
    sendJson(res, 400, { error: 'Invalid post type.' });
    return;
  }

  // Setting or clearing the Markdown source writes a protected meta key, which only the
  // companion plugin exposes; without it WordPress silently ignores the key, so a Markdown
  // save would falsely look successful. A content-only (HTML) save needs no connector.
  if (save.markdown !== undefined && !(await ensureConnectorAvailable(options, credentials))) {
    sendJson(res, 409, {
      error:
        'The companion plugin is required to save in Markdown mode, but it was not found on the site.',
    });
    return;
  }

  try {
    const post = await new WpClient(credentials).updatePostBody(id, type, {
      content: save.content,
      ...(save.markdown !== undefined ? { markdown: save.markdown } : {}),
    });
    sendJson(res, 200, { post });
  } catch (e) {
    if (!res.headersSent) {
      if (e instanceof WpRequestError && e.status === 404) {
        sendJson(res, 404, { error: 'Post not found.' });
      } else {
        sendJson(res, 502, { error: e instanceof Error ? e.message : 'Save failed' });
      }
    }
  }
}

/** Dispatch `/api/posts/<id>`: GET fetches a post for body editing, POST saves its body. */
async function handleSinglePost(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
  id: number,
): Promise<void> {
  if (!Number.isSafeInteger(id) || id <= 0) {
    sendJson(res, 400, { error: 'Invalid post id.' });
    return;
  }
  if (req.method === 'GET') {
    await handleGetPostForEdit(res, url, options, id);
    return;
  }
  if (req.method === 'POST') {
    await handleSavePostBody(req, res, options, id);
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed' });
}

async function handleConnection(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
): Promise<void> {
  if (req.method === 'GET') {
    const c = options.state.credentials;
    // Lazily detect the connector for connections that were never probed (e.g. seeded from env
    // vars or restored from secure storage), caching a definitive result so we hit the REST index
    // once. Concurrent first requests may probe more than once (benign; detection is
    // deterministic); a transient probe failure stays unknown and is re-probed next time.
    if (c) {
      await ensureConnectorAvailable(options, c);
    }
    const saved = await options.store.peek();
    sendJson(res, 200, {
      connected: c !== null,
      siteUrl: c?.siteUrl ?? null,
      connectorAvailable: options.state.connectorAvailable ?? false,
      canPersist: options.store.isAvailable(),
      persisted: saved !== null,
      savedSiteUrl: saved?.siteUrl ?? null,
    });
    return;
  }

  if (req.method === 'DELETE') {
    options.state.credentials = null;
    options.state.connectorAvailable = null;
    // `?forget=1` also erases the saved credentials; a plain disconnect keeps them so the
    // next launch can restore the connection.
    if (url.searchParams.get('forget') === '1') {
      await options.store.clear();
    }
    const saved = await options.store.peek();
    sendJson(res, 200, {
      connected: false,
      siteUrl: null,
      connectorAvailable: false,
      canPersist: options.store.isAvailable(),
      persisted: saved !== null,
      savedSiteUrl: saved?.siteUrl ?? null,
    });
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
    let credentials = parseCredentialsInput(body);
    // "Use saved connection": the browser sends no password; load it from secure storage.
    // Only honored when the client explicitly opts in (useSaved) and persistence is available.
    let fromSaved = false;
    if (!credentials) {
      if (parseUseSaved(body) && options.store.isAvailable()) {
        credentials = await options.store.load();
        fromSaved = credentials !== null;
      }
      if (!credentials) {
        sendJson(res, 400, {
          error: 'siteUrl, username, and applicationPassword are required.',
        });
        return;
      }
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
    // Detect the companion plugin; absence is not a connection failure (restricted mode). Reset
    // first so a fresh connection re-probes, and let a transient probe failure stay unknown
    // (re-probed on the next request) rather than pinning restricted mode.
    options.state.connectorAvailable = null;
    const connectorAvailable = await ensureConnectorAvailable(options, credentials);
    // Optionally persist to OS secure storage. Saving is best-effort: a save failure does not
    // fail the (already successful) connection — the UI learns the outcome from `persisted`.
    // A connection made *from* saved credentials is already persisted; don't re-save.
    let persisted = fromSaved;
    if (!fromSaved && parseRememberFlag(body) && options.store.isAvailable()) {
      try {
        await options.store.save(credentials);
        persisted = true;
      } catch {
        persisted = false;
      }
    }
    sendJson(res, 200, {
      connected: true,
      siteUrl: credentials.siteUrl,
      connectorAvailable,
      canPersist: options.store.isAvailable(),
      persisted,
      savedSiteUrl: persisted ? credentials.siteUrl : null,
    });
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

/** List the site's REST taxonomies, optionally filtered to a post type. Core REST — no plugin. */
async function handleTaxonomies(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  const credentials = options.state.credentials;
  if (!credentials) {
    sendJson(res, 200, { taxonomies: [] });
    return;
  }
  const type = url.searchParams.get('type');
  if (type !== null && !/^[a-z0-9_-]+$/i.test(type)) {
    sendJson(res, 400, { error: 'Invalid post type.' });
    return;
  }
  try {
    const taxonomies = await new WpClient(credentials).listTaxonomies(type ?? undefined);
    sendJson(res, 200, { taxonomies });
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: e instanceof Error ? e.message : 'Upstream request failed' });
    }
  }
}

/**
 * Create a new taxonomy term (`POST /api/terms` with `{ taxonomy, name, parent? }`). Core REST;
 * WordPress enforces the caller's term-management capability (a 403 is surfaced as such).
 */
async function handleTermCreate(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
): Promise<void> {
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
  const request = parseTermCreate(body);
  if (!request) {
    sendJson(res, 400, { error: 'Invalid term payload.' });
    return;
  }
  try {
    const term = await new WpClient(credentials).createTerm(
      request.taxonomy,
      request.parent !== undefined ? { name: request.name, parent: request.parent } : { name: request.name },
    );
    sendJson(res, 200, { term });
  } catch (e) {
    if (!res.headersSent) {
      if (e instanceof WpRequestError && e.status === 403) {
        sendJson(res, 403, { error: 'You do not have permission to create terms in this taxonomy.' });
      } else {
        sendJson(res, 502, { error: e instanceof Error ? e.message : 'Term creation failed' });
      }
    }
  }
}

/**
 * GET: list or resolve taxonomy terms. `?taxonomy=<restBase>` is required; `?include=<ids>`
 * resolves specific ids (to label the grid), `?all=1` fetches every term (for a hierarchy tree),
 * otherwise it lists/searches/pages. POST: create a term. Core REST — no companion plugin.
 */
async function handleTerms(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
): Promise<void> {
  if (req.method === 'POST') {
    await handleTermCreate(req, res, options);
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  const credentials = options.state.credentials;
  if (!credentials) {
    sendJson(res, 200, { items: [], totalPages: 1 });
    return;
  }
  const taxonomy = url.searchParams.get('taxonomy');
  if (taxonomy === null || !/^[a-z0-9_-]+$/i.test(taxonomy)) {
    sendJson(res, 400, { error: 'Invalid or missing taxonomy.' });
    return;
  }
  const client = new WpClient(credentials);
  try {
    const include = url.searchParams.get('include');
    if (include !== null) {
      const ids = include
        .split(',')
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n));
      sendJson(res, 200, { items: await client.resolveTerms(taxonomy, ids) });
      return;
    }
    const search = url.searchParams.get('search') ?? undefined;
    if (url.searchParams.get('all') === '1') {
      // Every term, for building a complete hierarchy tree client-side (`truncated` warns when
      // the page cap stopped short of a very large taxonomy).
      const all = await client.listAllTerms(taxonomy, search ? { search } : {});
      sendJson(res, 200, { items: all.items, truncated: all.truncated });
      return;
    }
    const pageRaw = url.searchParams.get('page');
    const page = pageRaw ? Number.parseInt(pageRaw, 10) : undefined;
    const result = await client.listTerms(taxonomy, {
      ...(page && page > 0 ? { page } : {}),
      ...(search ? { search } : {}),
    });
    sendJson(res, 200, { items: result.items, totalPages: result.totalPages });
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: e instanceof Error ? e.message : 'Upstream request failed' });
    }
  }
}

/**
 * Update (PATCH) or delete (DELETE) one taxonomy term in the manager. `?taxonomy=<restBase>` is
 * required (to build the term route). Core REST; WordPress enforces the caller's term-management
 * capability, so a 403 is surfaced as such. Delete uses `force=true` (terms have no trash).
 */
async function handleSingleTerm(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
  id: number,
): Promise<void> {
  if (req.method !== 'PATCH' && req.method !== 'DELETE') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  if (!Number.isSafeInteger(id) || id <= 0) {
    sendJson(res, 400, { error: 'Invalid term id.' });
    return;
  }
  const credentials = options.state.credentials;
  if (!credentials) {
    sendJson(res, 409, { error: 'Not connected' });
    return;
  }
  const taxonomy = url.searchParams.get('taxonomy');
  if (taxonomy === null || !/^[a-z0-9_-]+$/i.test(taxonomy)) {
    sendJson(res, 400, { error: 'Invalid or missing taxonomy.' });
    return;
  }
  const client = new WpClient(credentials);

  if (req.method === 'DELETE') {
    try {
      await client.deleteTerm(taxonomy, id);
      sendJson(res, 200, { deleted: true });
    } catch (e) {
      if (!res.headersSent) {
        if (e instanceof WpRequestError && e.status === 403) {
          sendJson(res, 403, { error: 'You do not have permission to delete terms in this taxonomy.' });
        } else {
          sendJson(res, 502, { error: e instanceof Error ? e.message : 'Term deletion failed' });
        }
      }
    }
    return;
  }

  // PATCH (update)
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
  const update = parseTermUpdate(body);
  if (!update) {
    sendJson(res, 400, { error: 'Invalid term update payload.' });
    return;
  }
  if (update.parent === id) {
    sendJson(res, 400, { error: 'A term cannot be its own parent.' });
    return;
  }
  try {
    const term = await client.updateTerm(taxonomy, id, update);
    sendJson(res, 200, { term });
  } catch (e) {
    if (!res.headersSent) {
      if (e instanceof WpRequestError && e.status === 403) {
        sendJson(res, 403, { error: 'You do not have permission to edit terms in this taxonomy.' });
      } else {
        sendJson(res, 502, { error: e instanceof Error ? e.message : 'Term update failed' });
      }
    }
  }
}

async function handleApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
): Promise<void> {
  if (url.pathname === '/api/connection') {
    await handleConnection(req, res, url, options);
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
  if (url.pathname === '/api/posts/import') {
    await handlePostsImport(req, res, options);
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
  if (url.pathname === '/api/relation') {
    await handleRelation(req, res, options);
    return;
  }
  if (url.pathname === '/api/print/posts') {
    await handlePrintPosts(req, res, url, options);
    return;
  }
  if (url.pathname === '/api/media') {
    await handleMedia(req, res, url, options);
    return;
  }
  if (url.pathname === '/api/taxonomies') {
    await handleTaxonomies(req, res, url, options);
    return;
  }
  if (url.pathname === '/api/terms') {
    await handleTerms(req, res, url, options);
    return;
  }
  const singleTerm = SINGLE_TERM_PATH.exec(url.pathname);
  if (singleTerm) {
    await handleSingleTerm(req, res, url, options, Number.parseInt(singleTerm[1] ?? '', 10));
    return;
  }
  const singlePost = SINGLE_POST_PATH.exec(url.pathname);
  if (singlePost) {
    await handleSinglePost(req, res, url, options, Number.parseInt(singlePost[1] ?? '', 10));
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
