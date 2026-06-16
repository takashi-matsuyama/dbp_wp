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
  ListPostsParams,
  UpdatePostFields,
  WpCredentials,
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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
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

    return (await response.json()) as T;
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

function normalizePost(raw: WpPostResponse): WpPost {
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
  // Parent relation rides the standard `meta` field (registered by the connector). A
  // missing/zero id or empty type reads as "no parent", so only a complete pair is set.
  const rawParent = raw.meta?.[PARENT_META_KEY];
  if (typeof rawParent === 'number' && Number.isInteger(rawParent) && rawParent > 0) {
    post.parent = rawParent;
  }
  const rawParentType = raw.meta?.[PARENT_TYPE_META_KEY];
  if (typeof rawParentType === 'string' && rawParentType !== '') {
    post.parentType = rawParentType;
  }
  return post;
}
