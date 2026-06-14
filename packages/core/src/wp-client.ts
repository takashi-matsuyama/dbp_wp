import type { ListPostsParams, WpCredentials, WpPost } from './types';

/**
 * Build the HTTP Basic `Authorization` header value from Application Password
 * credentials. WordPress treats the Application Password as the Basic-auth password.
 */
export function buildAuthHeader(credentials: WpCredentials): string {
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
  constructor(private readonly credentials: WpCredentials) {}

  private get restBase(): string {
    return `${this.credentials.siteUrl.replace(/\/+$/, '')}/wp-json`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.restBase}${path}`, {
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

  /** List posts of a given type. */
  async listPosts(params: ListPostsParams = {}): Promise<WpPost[]> {
    const type = params.type ?? 'posts';
    const perPage = params.perPage ?? 100;
    const page = params.page ?? 1;
    const query = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
    });
    return this.request<WpPost[]>(`/wp/v2/${encodeURIComponent(type)}?${query.toString()}`);
  }

  /**
   * Update post meta. Editing arbitrary meta keys requires the companion plugin
   * (`dbp-wp-connector`); WordPress core only exposes meta registered with
   * `show_in_rest`. See planning decision Q2 (案c).
   */
  async updatePostMeta(
    id: number,
    meta: Record<string, unknown>,
    type = 'posts',
  ): Promise<WpPost> {
    return this.request<WpPost>(`/wp/v2/${encodeURIComponent(type)}/${id}`, {
      method: 'POST',
      body: JSON.stringify({ meta }),
    });
  }
}
