import { buildPrintRecord, type PrintRecord } from './print';
import {
  PARENT_META_KEY,
  PARENT_TYPE_META_KEY,
  buildClearRelationMeta,
  buildSetRelationMeta,
  type RelationTarget,
} from './relation';
import type {
  DeleteMetaResult,
  ListMediaParams,
  ListPostsParams,
  UpdatePostFields,
  WpCredentials,
  WpMedia,
  WpPost,
  WpPostEdit,
  WpPostResponse,
  WpPostType,
} from './types';

/** Hosts for which plain http is tolerated (local development). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Allowed characters for a REST route segment (post type slug). No dots: a `.`/`..`
 *  segment would be resolved by the URL parser and traverse the REST path. */
const ROUTE_SEGMENT = /^[a-z0-9_-]+$/i;

/** REST field added by the companion plugin to carry arbitrary post meta. */
const META_FIELD = 'dbp_wp_meta';

/**
 * Meta key holding the lossless Markdown source for a post edited in Markdown mode. An
 * underscore-prefixed (protected) key, so the companion plugin must register it with
 * `register_post_meta` + an `edit_post` auth callback to expose it over REST — the generic
 * `dbp_wp_meta` field excludes protected keys. Like the relation keys, it therefore rides
 * the standard core `meta` field, not `dbp_wp_meta`.
 */
export const MARKDOWN_META_KEY = '_dbp_wp_markdown';

/** REST namespace registered by the companion plugin. */
const CONNECTOR_NAMESPACE = 'dbp-wp/v1';

/**
 * Validate and normalize a WordPress site URL into a REST base (origin + base path).
 *
 * Requires https, except plain http is allowed for local development hosts. Rejects
 * embedded credentials, query strings, and fragments, and strips trailing slashes — so
 * an Application Password is never sent over cleartext to an unexpected target.
 */
export function normalizeSiteUrl(siteUrl: string): string {
  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    throw new Error(`Invalid site URL: ${siteUrl}`);
  }

  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error(`Site URL must use https (http is allowed only for local hosts): ${siteUrl}`);
  }
  // SSRF defense: the client sends the Application Password to whatever the site URL points to,
  // so block private, loopback, and link-local IP-literal targets (e.g. 10.x, 192.168.x,
  // 169.254.169.254 cloud metadata, IPv6 ULA/link-local). The explicit local-dev hosts stay
  // allowed. This covers IP literals only — a hostname that resolves to a private address (DNS
  // rebinding) is not caught here, as fetch does not expose the resolved address.
  if (!isLocal && isPrivateAddress(url.hostname)) {
    throw new Error(`Site URL must not point to a private or local network address: ${siteUrl}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Site URL must not contain embedded credentials.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('Site URL must not contain a query string or fragment.');
  }

  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * True when a URL hostname is an IP literal in a private, loopback, link-local, or unspecified
 * range — the SSRF block list used by {@link normalizeSiteUrl}. Returns false for DNS hostnames
 * (not resolved here) and for public IPs. Exported for unit testing.
 */
export function isPrivateAddress(hostname: string): boolean {
  // IPv4 literal.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (v4) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (octets.some((o) => o > 255)) {
      return false; // not a valid IPv4 literal
    }
    return isPrivateV4(octets);
  }
  // IPv6 literal. A URL's hostname keeps the brackets (e.g. `[fe80::1]`), so strip them.
  if (hostname.includes(':')) {
    return isPrivateV6(hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, ''));
  }
  return false; // DNS hostname or non-literal: not blocked here
}

/** True for private, loopback, link-local, or unspecified IPv4 octets. */
function isPrivateV4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local (incl. 169.254.169.254 metadata)
    (a === 172 && b !== undefined && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) // private
  );
}

/**
 * Expand an IPv6 literal to its 8 16-bit groups, or null if unparseable. Handles `::`
 * compression and an embedded dotted-quad tail (e.g. `::ffff:1.2.3.4`). The WHATWG URL parser
 * canonicalizes an IPv4-mapped address to hex (`[::ffff:7f00:1]`), so the range check must work
 * on the expanded groups rather than string-matching the dotted form.
 */
function expandV6(input: string): number[] | null {
  let s = input;
  // Convert a trailing dotted-quad to two hex groups.
  const v4m = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4m) {
    const o = [Number(v4m[2]), Number(v4m[3]), Number(v4m[4]), Number(v4m[5])];
    if (o.some((x) => x > 255)) {
      return null;
    }
    s = `${v4m[1]}${(((o[0] as number) << 8) | (o[1] as number)).toString(16)}:${(((o[2] as number) << 8) | (o[3] as number)).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) {
    return null;
  }
  const toGroups = (side: string): number[] | null => {
    if (side === '') {
      return [];
    }
    const out: number[] = [];
    for (const part of side.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return null;
      }
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const left = toGroups(halves[0] ?? '');
  if (left === null) {
    return null;
  }
  if (halves.length === 2) {
    const right = toGroups(halves[1] ?? '');
    if (right === null) {
      return null;
    }
    const gap = 8 - left.length - right.length;
    if (gap < 1) {
      return null; // `::` must stand for at least one zero group
    }
    return [...left, ...new Array<number>(gap).fill(0), ...right];
  }
  return left.length === 8 ? left : null;
}

/** True for IPv6 loopback/unspecified, ULA (fc00::/7), link-local (fe80::/10), or a mapped private v4. */
function isPrivateV6(addr: string): boolean {
  const groups = expandV6((addr.split('%')[0] ?? '').trim()); // drop any zone id
  if (groups === null) {
    return false;
  }
  if (groups.every((g) => g === 0)) {
    return true; // :: unspecified
  }
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return true; // ::1 loopback
  }
  const first = groups[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) {
    return true; // ULA fc00::/7
  }
  if ((first & 0xffc0) === 0xfe80) {
    return true; // link-local fe80::/10
  }
  // IPv4-mapped ::ffff:a.b.c.d
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const g6 = groups[6] ?? 0;
    const g7 = groups[7] ?? 0;
    return isPrivateV4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]);
  }
  return false;
}

/**
 * Build the HTTP Basic `Authorization` header value from Application Password
 * credentials. WordPress treats the Application Password as the Basic-auth password.
 */
export function buildAuthHeader(credentials: WpCredentials): string {
  if (credentials.username.includes(':')) {
    throw new Error('Username must not contain a colon (":") for HTTP Basic authentication.');
  }
  const token = `${credentials.username}:${credentials.applicationPassword}`;
  const base64 = Buffer.from(token, 'utf-8').toString('base64');
  return `Basic ${base64}`;
}

/** Error thrown when the WordPress REST API returns a non-2xx response. */
export class WpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'WpRequestError';
  }
}

/**
 * Minimal WordPress REST client.
 *
 * Runs in the Node process (CLI shell), never in the browser, so Application Password
 * credentials stay server-side. MVP scope: list posts, read/write post meta.
 */
export class WpClient {
  private readonly restBase: string;

  constructor(private readonly credentials: WpCredentials) {
    this.restBase = normalizeSiteUrl(credentials.siteUrl);
  }

  /**
   * Send an authenticated request and return the raw {@link Response} (throwing on non-2xx),
   * so callers that need response headers — e.g. media pagination via `X-WP-TotalPages` —
   * can read them. A JSON `Content-Type` is declared only when a body is sent; a caller may
   * override it via `init.headers` (the media upload sends the file's own type).
   */
  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.restBase}/wp-json${path}`, {
      ...init,
      headers: {
        Authorization: buildAuthHeader(this.credentials),
        // Only declare a JSON body when one is actually sent (GETs carry none).
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw new WpRequestError(
        response.status,
        path,
        `WordPress REST request failed: ${response.status} ${response.statusText}`,
      );
    }

    return response;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.send(path, init)).json() as Promise<T>;
  }

  /**
   * List the REST-enabled post types on the site (edit context), so the app can offer
   * a type selector. Returns each type's REST route base and display name.
   */
  async listPostTypes(): Promise<WpPostType[]> {
    const raw = await this.request<unknown>('/wp/v2/types?context=edit');
    return normalizePostTypes(raw);
  }

  /** List posts of a given type in edit context (raw fields, for editing). */
  async listPosts(params: ListPostsParams = {}): Promise<WpPost[]> {
    const type = params.type ?? 'posts';
    assertRouteSegment(type);
    const perPage = clampInt(params.perPage ?? 100, 1, 100);
    const page = clampInt(params.page ?? 1, 1, Number.MAX_SAFE_INTEGER);
    const query = new URLSearchParams({
      context: 'edit',
      per_page: String(perPage),
      page: String(page),
    });
    const raw = await this.request<WpPostResponse[]>(`/wp/v2/${type}?${query.toString()}`);
    return raw.map(normalizePost);
  }

  /**
   * List posts as {@link PrintRecord}s for Print Design. Requests `_embed` (so featured
   * media and taxonomy terms come back inline) plus `content`/`excerpt`; the standard
   * table/spreadsheet listing ({@link WpClient.listPosts}) is unaffected.
   */
  async listPostsForPrint(params: ListPostsParams = {}): Promise<PrintRecord[]> {
    const type = params.type ?? 'posts';
    assertRouteSegment(type);
    const perPage = clampInt(params.perPage ?? 100, 1, 100);
    const page = clampInt(params.page ?? 1, 1, Number.MAX_SAFE_INTEGER);
    const query = new URLSearchParams({
      context: 'edit',
      per_page: String(perPage),
      page: String(page),
      _embed: '1',
    });
    const raw = await this.request<WpPostResponse[]>(`/wp/v2/${type}?${query.toString()}`);
    return raw.map(buildPrintRecord);
  }

  /**
   * Update post fields in a single request. Standard fields (title, menu_order,
   * status) are core REST fields and need no plugin. When `meta` is supplied it rides
   * the same request through the companion plugin's `dbp_wp_meta` field (ignored by
   * WordPress without the connector). Pass the REST route slug as `type` (e.g.
   * `posts`, `pages`) — not the object type returned on a post.
   */
  async updatePost(
    id: number,
    fields: UpdatePostFields,
    type = 'posts',
    meta?: Record<string, unknown>,
  ): Promise<WpPost> {
    assertPostId(id);
    assertRouteSegment(type);
    const raw = await this.request<WpPostResponse>(`/wp/v2/${type}/${String(id)}?context=edit`, {
      method: 'POST',
      body: JSON.stringify(buildPostBody(fields, meta)),
    });
    return normalizePost(raw);
  }

  /**
   * Create a new post in a single request, symmetric to {@link WpClient.updatePost}.
   * Standard fields (title, menu_order, status) are core REST fields; when `meta` is
   * supplied it rides the same request through the companion plugin's `dbp_wp_meta`
   * field. Pass the REST route slug as `type` (e.g. `posts`, `pages`).
   */
  async createPost(
    fields: UpdatePostFields,
    type = 'posts',
    meta?: Record<string, unknown>,
  ): Promise<WpPost> {
    assertRouteSegment(type);
    const raw = await this.request<WpPostResponse>(`/wp/v2/${type}?context=edit`, {
      method: 'POST',
      body: JSON.stringify(buildPostBody(fields, meta)),
    });
    return normalizePost(raw);
  }

  /**
   * Update only arbitrary post meta through the companion plugin's `dbp_wp_meta`
   * field. A thin wrapper over {@link WpClient.updatePost} with no standard fields.
   * Requires the connector; the connector writes scalar values only.
   */
  async updatePostMeta(
    id: number,
    meta: Record<string, unknown>,
    type = 'posts',
  ): Promise<WpPost> {
    return this.updatePost(id, {}, type, meta);
  }

  /**
   * Fetch a single post for body editing (edit context), returning the raw body
   * (`content.raw`) and, when present, the lossless Markdown source from
   * `_dbp_wp_markdown`. The standard listing ({@link WpClient.listPosts}) omits the body, so
   * the editor uses this dedicated read. The Markdown source comes back via the standard
   * `meta` field only when the connector registered the key; in restricted mode the post is
   * HTML-only. Pass the REST route slug as `type`.
   */
  async getPostForEdit(id: number, type = 'posts'): Promise<WpPostEdit> {
    assertPostId(id);
    assertRouteSegment(type);
    const raw = await this.request<WpPostResponse>(`/wp/v2/${type}/${String(id)}?context=edit`);
    return normalizePostForEdit(raw);
  }

  /**
   * Save a single post's body. Writes `content` (core REST) and, when `markdown` is given,
   * the `_dbp_wp_markdown` source via the standard `meta` field (registered by the connector)
   * — both in one request. Pass `markdown` as the source string for Markdown mode, `null` to
   * clear it (HTML mode on a post previously saved as Markdown), or omit it for an HTML-only
   * post. Writing/clearing `markdown` requires the connector; a content-only save does not.
   * Returns the re-fetched edit model (edit context), so the caller sees the persisted mode.
   */
  async updatePostBody(
    id: number,
    type: string,
    body: { content: string; markdown?: string | null },
  ): Promise<WpPostEdit> {
    assertPostId(id);
    assertRouteSegment(type);
    const reqBody = buildUpdateBody({ content: body.content });
    if (body.markdown !== undefined) {
      // Standard `meta` field (like the relation keys), not the connector's `dbp_wp_meta`:
      // `_dbp_wp_markdown` is protected and is only writable through register_post_meta.
      // `null` makes WordPress delete the key (no stale source left to mis-detect the mode).
      reqBody.meta = { [MARKDOWN_META_KEY]: body.markdown };
    }
    const raw = await this.request<WpPostResponse>(`/wp/v2/${type}/${String(id)}?context=edit`, {
      method: 'POST',
      body: JSON.stringify(reqBody),
    });
    return normalizePostForEdit(raw);
  }

  /**
   * Delete named meta keys from a single post via the companion plugin's
   * `DELETE /dbp-wp/v1/posts/<id>/meta` route. This route is keyed by id only (the
   * post type is irrelevant). Requires the connector.
   */
  async deletePostMeta(id: number, keys: string[]): Promise<DeleteMetaResult> {
    assertPostId(id);
    const cleanKeys = sanitizeMetaKeys(keys);
    // Use send() (not request()) so an empty/204 response from the connector does not throw in
    // JSON.parse; parseDeleteMetaResponse tolerates it.
    const response = await this.send(`/${CONNECTOR_NAMESPACE}/posts/${String(id)}/meta`, {
      method: 'DELETE',
      body: JSON.stringify({ keys: cleanKeys }),
    });
    return parseDeleteMetaResponse(await response.text(), id, cleanKeys);
  }

  /**
   * Set a child post's parent relation. The relation keys ride the standard core `meta`
   * field (the connector registers them with `register_post_meta`), so this is a distinct
   * path from {@link WpClient.updatePostMeta} (which uses the connector's `dbp_wp_meta`
   * field). Validates the assignment (positive id, valid type, no self-parent) before
   * writing. Requires the connector; without it WordPress silently ignores the keys.
   */
  async setRelation(
    childId: number,
    childType: string,
    relation: RelationTarget,
  ): Promise<WpPost> {
    assertPostId(childId);
    assertRouteSegment(childType);
    const raw = await this.request<WpPostResponse>(
      `/wp/v2/${childType}/${String(childId)}?context=edit`,
      { method: 'POST', body: JSON.stringify({ meta: buildSetRelationMeta(childId, relation) }) },
    );
    return normalizePost(raw);
  }

  /**
   * Clear a child post's parent relation. Sends `null` for both relation keys, which makes
   * WordPress delete them (no stale `0`/empty value left behind). Requires the connector.
   */
  async clearRelation(childId: number, childType: string): Promise<WpPost> {
    assertPostId(childId);
    assertRouteSegment(childType);
    const raw = await this.request<WpPostResponse>(
      `/wp/v2/${childType}/${String(childId)}?context=edit`,
      { method: 'POST', body: JSON.stringify({ meta: buildClearRelationMeta() }) },
    );
    return normalizePost(raw);
  }

  /**
   * Detect whether the companion plugin is active by checking the REST index
   * (`/wp-json/`) for the connector's namespace. Throws on a failed request; a caller
   * that wants a non-fatal probe should treat a thrown error as "not available".
   */
  async detectConnector(): Promise<boolean> {
    const index = await this.request<{ namespaces?: unknown }>('/');
    return hasConnectorNamespace(index.namespaces);
  }

  /**
   * Upload an image to the media library via core REST (`POST /wp/v2/media`), the same
   * contract WordPress uses: raw bytes with a `Content-Disposition` filename and the file's
   * MIME type (octet-stream when unknown). No companion plugin needed; the authenticated
   * user must have `upload_files`. Returns the normalized media item.
   */
  async uploadMedia(bytes: Uint8Array, filename: string, mimeType?: string): Promise<WpMedia> {
    const response = await this.send('/wp/v2/media', {
      method: 'POST',
      body: bytes,
      headers: {
        'Content-Type': mimeType && mimeType.length > 0 ? mimeType : 'application/octet-stream',
        'Content-Disposition': buildContentDisposition(filename),
      },
    });
    return normalizeMedia(await response.json());
  }

  /**
   * List image attachments (`GET /wp/v2/media?media_type=image`), paginated. Reads the
   * `X-WP-TotalPages` response header so the picker can page through the library. A core
   * REST call — no companion plugin needed.
   */
  async listMedia(params: ListMediaParams = {}): Promise<{ items: WpMedia[]; totalPages: number }> {
    const perPage = clampInt(params.perPage ?? 30, 1, 100);
    const page = clampInt(params.page ?? 1, 1, Number.MAX_SAFE_INTEGER);
    const query = new URLSearchParams({
      media_type: 'image',
      per_page: String(perPage),
      page: String(page),
    });
    const search = params.search?.trim();
    if (search) {
      query.set('search', search);
    }
    const response = await this.send(`/wp/v2/media?${query.toString()}`);
    const raw = (await response.json()) as unknown;
    return {
      items: Array.isArray(raw) ? raw.map(normalizeMedia) : [],
      totalPages: parseTotalPages(response.headers.get('X-WP-TotalPages')),
    };
  }

  /**
   * Resolve specific media ids to their URLs in one request (`?include=`), used to fill in
   * the featured-image thumbnails for the posts currently shown — without embedding media
   * into the lean post listing. A core REST call — no companion plugin needed.
   */
  async resolveMedia(ids: number[]): Promise<WpMedia[]> {
    const clean = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (clean.length === 0) {
      return [];
    }
    // WordPress caps per_page at 100, so resolve in chunks of 100 — otherwise a request for
    // more than 100 ids would be silently truncated, leaving the rest unresolved.
    const out: WpMedia[] = [];
    for (let i = 0; i < clean.length; i += 100) {
      const chunk = clean.slice(i, i + 100);
      const query = new URLSearchParams({
        include: chunk.join(','),
        per_page: String(chunk.length),
      });
      const raw = await this.request<unknown>(`/wp/v2/media?${query.toString()}`);
      if (Array.isArray(raw)) {
        out.push(...raw.map(normalizeMedia));
      }
    }
    return out;
  }
}

/** Map editable fields to the WordPress REST request body (camelCase → snake_case). */
export function buildUpdateBody(fields: UpdatePostFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.title !== undefined) {
    body.title = fields.title;
  }
  if (fields.menuOrder !== undefined) {
    body.menu_order = fields.menuOrder;
  }
  if (fields.status !== undefined) {
    body.status = fields.status;
  }
  if (fields.featuredMedia !== undefined) {
    // `0` is meaningful here (removes the featured image), so check for undefined, not falsy.
    body.featured_media = fields.featuredMedia;
  }
  if (fields.content !== undefined) {
    // `''` is meaningful here (clears the body), so check for undefined, not falsy.
    body.content = fields.content;
  }
  return body;
}

function assertRouteSegment(segment: string): void {
  if (!ROUTE_SEGMENT.test(segment)) {
    throw new Error(`Invalid REST route segment: ${segment}`);
  }
}

function assertPostId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid post id: ${id}`);
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Wrap arbitrary meta in the companion plugin's REST field for a write request. */
export function buildMetaBody(meta: Record<string, unknown>): Record<string, unknown> {
  return { [META_FIELD]: meta };
}

/**
 * Build a post-update body, folding in connector meta under `dbp_wp_meta` when given.
 * A provided `meta` is included as-is, even when empty — callers that should skip empty
 * meta (e.g. the CLI batch parser) omit it before calling.
 */
export function buildPostBody(
  fields: UpdatePostFields,
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  const body = buildUpdateBody(fields);
  if (meta !== undefined) {
    Object.assign(body, buildMetaBody(meta));
  }
  return body;
}

/**
 * Parse a per-post meta-delete response. `send()` already threw on a non-2xx status, so an empty
 * body (e.g. a 204 from a backend that returns no content) or a non-JSON body means the delete
 * succeeded — the requested keys are reported as deleted. A JSON body's `deleted` list (the keys
 * actually present) takes precedence, and the request `id` is trusted over a malformed `post_id`.
 */
export function parseDeleteMetaResponse(
  body: string,
  id: number,
  requestedKeys: string[],
): DeleteMetaResult {
  const text = body.trim();
  if (text === '') {
    return { postId: id, deleted: [...requestedKeys] };
  }
  let raw: { post_id?: unknown; deleted?: unknown };
  try {
    raw = JSON.parse(text) as { post_id?: unknown; deleted?: unknown };
  } catch {
    return { postId: id, deleted: [...requestedKeys] };
  }
  return {
    // Trust the request `id` over a malformed `post_id` (0, negative, or fractional included).
    postId:
      typeof raw.post_id === 'number' && Number.isSafeInteger(raw.post_id) && raw.post_id > 0
        ? raw.post_id
        : id,
    deleted: Array.isArray(raw.deleted)
      ? raw.deleted.filter((k): k is string => typeof k === 'string')
      : [],
  };
}

/** Validate and clean a list of meta keys for deletion (non-empty strings only). */
export function sanitizeMetaKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) {
    throw new Error('Meta keys must be an array of strings.');
  }
  const clean = keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
  if (clean.length === 0) {
    throw new Error('At least one non-empty meta key is required.');
  }
  return clean;
}

/** True when a REST index `namespaces` list includes the connector namespace. */
export function hasConnectorNamespace(namespaces: unknown): boolean {
  return Array.isArray(namespaces) && namespaces.includes(CONNECTOR_NAMESPACE);
}

/**
 * Build a `Content-Disposition` value for a media upload. Emits an ASCII-only
 * `filename="…"` fallback (non-ASCII and header-unsafe characters replaced with `_`) plus an
 * RFC 5987 `filename*=UTF-8''…` parameter, so a non-ASCII filename survives and never
 * produces an invalid (non-ByteString) header value that `fetch` would reject. The path is
 * reduced to its basename and quotes/CR/LF are dropped so the value cannot break the header.
 */
export function buildContentDisposition(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const trimmed = base.replace(/[\r\n"]/g, '').trim() || 'upload';
  const ascii = trimmed.replace(/[^\x20-\x7e]/g, '_');
  // Percent-encode per RFC 5987, also encoding the chars encodeURIComponent leaves bare.
  const encoded = encodeURIComponent(trimmed).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Parse the `X-WP-TotalPages` header into a positive page count, defaulting to 1. */
function parseTotalPages(header: string | null): number {
  if (header === null) {
    return 1;
  }
  const n = Number.parseInt(header, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Read `<obj>.rendered` as a string, or `''` when absent/malformed. */
function extractRendered(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const rendered = (value as Record<string, unknown>).rendered;
    if (typeof rendered === 'string') {
      return rendered;
    }
  }
  return '';
}

/** Prefer a thumbnail-sized URL from `media_details.sizes`, else a medium one, else `''`. */
function extractThumbnailUrl(mediaDetails: unknown): string {
  if (mediaDetails === null || typeof mediaDetails !== 'object') {
    return '';
  }
  const sizes = (mediaDetails as Record<string, unknown>).sizes;
  if (sizes === null || typeof sizes !== 'object') {
    return '';
  }
  for (const sizeName of ['thumbnail', 'medium']) {
    const size = (sizes as Record<string, unknown>)[sizeName];
    if (size !== null && typeof size === 'object') {
      const url = (size as Record<string, unknown>).source_url;
      if (typeof url === 'string') {
        return url;
      }
    }
  }
  return '';
}

/**
 * Normalize a raw `/wp/v2/media` item into {@link WpMedia}. Accepts `unknown` and guards each
 * field, so a malformed entry degrades to empty strings rather than throwing.
 */
export function normalizeMedia(raw: unknown): WpMedia {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const sourceUrl = typeof obj.source_url === 'string' ? obj.source_url : '';
  return {
    id: typeof obj.id === 'number' ? obj.id : 0,
    sourceUrl,
    thumbnailUrl: extractThumbnailUrl(obj.media_details) || sourceUrl,
    title: extractRendered(obj.title),
    mimeType: typeof obj.mime_type === 'string' ? obj.mime_type : '',
  };
}

/**
 * Normalize the `/wp/v2/types` response (an object keyed by type name) into a list.
 * Skips entries without a string `rest_base` (not addressable over REST).
 */
export function normalizePostTypes(raw: unknown): WpPostType[] {
  if (typeof raw !== 'object' || raw === null) {
    return [];
  }
  const result: WpPostType[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    // Validate rest_base at ingestion so a malformed slug can't become a broken option.
    if (typeof entry.rest_base !== 'string' || !ROUTE_SEGMENT.test(entry.rest_base)) {
      continue;
    }
    result.push({
      slug: typeof entry.slug === 'string' ? entry.slug : key,
      restBase: entry.rest_base,
      name: typeof entry.name === 'string' ? entry.name : key,
    });
  }
  return result;
}

export function normalizePost(raw: WpPostResponse): WpPost {
  const post: WpPost = {
    id: raw.id,
    type: raw.type,
    status: raw.status,
    title: raw.title.raw ?? raw.title.rendered,
    menuOrder: raw.menu_order,
    meta: raw.meta,
  };
  if (raw.dbp_wp_meta !== undefined) {
    post.dbpWpMeta = raw.dbp_wp_meta;
  }
  // featured_media is always present on a core post; 0 means "no featured image".
  if (typeof raw.featured_media === 'number' && raw.featured_media > 0) {
    post.featuredMedia = raw.featured_media;
  }
  // Parent relation rides the standard `meta` field (registered by the connector). It needs
  // both a positive id and a non-empty type; a half-written pair — e.g. from a raw REST
  // write that set only one key, or a parent type sanitized to '' — reads as no relation.
  // parent and parentType are therefore set together or not at all, so normalizePost,
  // getRelation, and deriveChildren stay consistent on malformed data.
  const rawParent = raw.meta?.[PARENT_META_KEY];
  const rawParentType = raw.meta?.[PARENT_TYPE_META_KEY];
  if (
    typeof rawParent === 'number' &&
    Number.isInteger(rawParent) &&
    rawParent > 0 &&
    typeof rawParentType === 'string' &&
    rawParentType !== ''
  ) {
    post.parent = rawParent;
    post.parentType = rawParentType;
  }
  return post;
}

/**
 * Normalize a raw post (edit context) into the body-editing model {@link WpPostEdit}.
 *
 * Reads `content.raw` for the body. Mode is determined by the Markdown source: only a
 * *non-empty* `_dbp_wp_markdown` value marks Markdown mode. This mirrors the relation keys'
 * value-based sentinel (a positive id means "set") and sidesteps the REST default for a
 * registered string meta (an unset key can come back as `''`), so an HTML-mode post is never
 * mistaken for an empty-bodied Markdown post.
 */
export function normalizePostForEdit(raw: WpPostResponse): WpPostEdit {
  const edit: WpPostEdit = {
    id: raw.id,
    type: raw.type,
    status: raw.status,
    title: raw.title.raw ?? raw.title.rendered,
    content: raw.content?.raw ?? '',
  };
  const markdown = raw.meta?.[MARKDOWN_META_KEY];
  if (typeof markdown === 'string' && markdown !== '') {
    edit.markdown = markdown;
  }
  return edit;
}
