import type {
  ListPostsParams,
  UpdatePostFields,
  WpCredentials,
  WpPost,
  WpPostResponse,
} from './types';

/** Hosts for which plain http is tolerated (local development). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Allowed characters for a REST route segment (post type slug). */
const ROUTE_SEGMENT = /^[a-z0-9._-]+$/i;

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
        'Content-Type': 'application/json',
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
   * Update standard post fields (title, menu_order, status). These are core REST
   * fields and need no companion plugin. Pass the REST route slug as `type`
   * (e.g. `posts`, `pages`) — not the object type returned on a post.
   */
  async updatePost(id: number, fields: UpdatePostFields, type = 'posts'): Promise<WpPost> {
    assertPostId(id);
    assertRouteSegment(type);
    const raw = await this.request<WpPostResponse>(`/wp/v2/${type}/${String(id)}?context=edit`, {
      method: 'POST',
      body: JSON.stringify(buildUpdateBody(fields)),
    });
    return normalizePost(raw);
  }

  /**
   * Update post meta. Editing arbitrary meta keys requires the companion plugin;
   * WordPress core only exposes meta registered with `show_in_rest`.
   */
  async updatePostMeta(
    id: number,
    meta: Record<string, unknown>,
    type = 'posts',
  ): Promise<WpPost> {
    assertPostId(id);
    assertRouteSegment(type);
    const raw = await this.request<WpPostResponse>(`/wp/v2/${type}/${String(id)}?context=edit`, {
      method: 'POST',
      body: JSON.stringify({ meta }),
    });
    return normalizePost(raw);
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

function normalizePost(raw: WpPostResponse): WpPost {
  return {
    id: raw.id,
    type: raw.type,
    status: raw.status,
    title: raw.title.raw ?? raw.title.rendered,
    menuOrder: raw.menu_order,
    meta: raw.meta,
  };
}
