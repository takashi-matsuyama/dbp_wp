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
  if (url.username !== '' || url.password !== '') {
    throw new Error('Site URL must not contain embedded credentials.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('Site URL must not contain a query string or fragment.');
  }

  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
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
   * Delete named meta keys from a single post via the companion plugin's
   * `DELETE /dbp-wp/v1/posts/<id>/meta` route. This route is keyed by id only (the
   * post type is irrelevant). Requires the connector.
   */
  async deletePostMeta(id: number, keys: string[]): Promise<DeleteMetaResult> {
    assertPostId(id);
    const cleanKeys = sanitizeMetaKeys(keys);
    const raw = await this.request<{ post_id?: unknown; deleted?: string[] }>(
      `/${CONNECTOR_NAMESPACE}/posts/${String(id)}/meta`,
      { method: 'DELETE', body: JSON.stringify({ keys: cleanKeys }) },
    );
    // Trust our own request `id` over a malformed connector `post_id`.
    return {
      postId: typeof raw.post_id === 'number' ? raw.post_id : id,
      deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
    };
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
    const name = sanitizeFilename(filename);
    const response = await this.send('/wp/v2/media', {
      method: 'POST',
      body: bytes,
      headers: {
        'Content-Type': mimeType && mimeType.length > 0 ? mimeType : 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
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
    const query = new URLSearchParams({
      include: clean.join(','),
      per_page: String(clampInt(clean.length, 1, 100)),
    });
    const raw = await this.request<unknown>(`/wp/v2/media?${query.toString()}`);
    return Array.isArray(raw) ? raw.map(normalizeMedia) : [];
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

/** Reduce a filename to its basename and strip characters that could break a header. */
function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  // Drop quotes and CR/LF so the value cannot break out of the Content-Disposition header.
  const clean = base.replace(/["\r\n]/g, '').trim();
  return clean.length > 0 ? clean : 'upload';
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
