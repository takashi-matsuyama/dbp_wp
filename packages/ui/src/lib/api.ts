import type { WpPost, WpPostType } from '@dbp-wp/core';

// The UI talks only to the local CLI server (`/api/...`), never to WordPress directly,
// so the browser never holds credentials and is not subject to cross-origin rules.

export interface ListPostsQuery {
  type?: string;
  page?: number;
}

/** Build the local API path for listing posts. Exported for unit testing. */
export function listPostsPath(query: ListPostsQuery = {}): string {
  const params = new URLSearchParams();
  if (query.type) {
    params.set('type', query.type);
  }
  if (query.page && query.page > 1) {
    params.set('page', String(query.page));
  }
  const qs = params.toString();
  return qs ? `/api/posts?${qs}` : '/api/posts';
}

export interface PostsResponse {
  posts: WpPost[];
  /** True when the CLI has no WordPress credentials configured yet (skeleton mode). */
  unconfigured: boolean;
}

export async function fetchPosts(query: ListPostsQuery = {}): Promise<PostsResponse> {
  const res = await fetch(listPostsPath(query));
  if (!res.ok) {
    throw new Error(`Failed to load posts: ${res.status}`);
  }
  const data = (await res.json()) as Partial<PostsResponse>;
  return {
    posts: Array.isArray(data.posts) ? data.posts : [],
    unconfigured: data.unconfigured === true,
  };
}

/** Fetch the site's REST-enabled post types from the CLI (for the type selector). */
export async function fetchTypes(): Promise<WpPostType[]> {
  const res = await fetch('/api/types');
  if (!res.ok) {
    throw new Error(`Failed to load post types: ${res.status}`);
  }
  const data = (await res.json()) as { types?: unknown };
  return Array.isArray(data.types) ? (data.types as WpPostType[]) : [];
}

export interface ConnectionStatus {
  connected: boolean;
  siteUrl: string | null;
  /** Whether the companion plugin is active on the connected site (full mode). */
  connectorAvailable: boolean;
}

export interface ConnectInput {
  siteUrl: string;
  username: string;
  applicationPassword: string;
}

/** Read the current connection status from the CLI. */
export async function getConnection(): Promise<ConnectionStatus> {
  const res = await fetch('/api/connection');
  if (!res.ok) {
    throw new Error(`Failed to read connection status: ${res.status}`);
  }
  const data = (await res.json()) as Partial<ConnectionStatus>;
  return {
    connected: data.connected === true,
    siteUrl: typeof data.siteUrl === 'string' ? data.siteUrl : null,
    connectorAvailable: data.connectorAvailable === true,
  };
}

/**
 * Send credentials to the CLI, which holds them in memory and probes the connection.
 * The browser does not persist the credentials.
 */
export async function connect(input: ConnectInput): Promise<ConnectionStatus> {
  const res = await fetch('/api/connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<ConnectionStatus> & {
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? `Connection failed: ${res.status}`);
  }
  return {
    connected: data.connected ?? true,
    siteUrl: data.siteUrl ?? input.siteUrl,
    connectorAvailable: data.connectorAvailable ?? false,
  };
}

/** Clear the CLI's in-memory credentials. */
export async function disconnect(): Promise<void> {
  const res = await fetch('/api/connection', { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Disconnect failed: ${res.status}`);
  }
}

export interface PostUpdate {
  id: number;
  title?: string;
  menuOrder?: number;
  status?: string;
  /** Arbitrary meta to write via the companion plugin (full mode only). */
  meta?: Record<string, unknown>;
}

export interface UpdateResult {
  id: number;
  ok: boolean;
  error?: string;
}

/**
 * Send a batch of post edits to the CLI, which applies them over the WordPress REST API.
 * `type` is the REST route base of the post type being edited (defaults to `posts`).
 */
export async function savePosts(updates: PostUpdate[], type = 'posts'): Promise<UpdateResult[]> {
  const res = await fetch('/api/posts/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, updates }),
  });
  const data = (await res.json().catch(() => ({}))) as { results?: UpdateResult[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Save failed: ${res.status}`);
  }
  return Array.isArray(data.results) ? data.results : [];
}

/** A single new post to create on import (flattened standard fields plus optional meta). */
export interface ImportCreateInput {
  title?: string;
  menuOrder?: number;
  status?: string;
  /** Arbitrary meta to write via the companion plugin (full mode only). */
  meta?: Record<string, unknown>;
}

/** Result of creating one imported post (no input id; the new id comes back on success). */
export interface ImportResult {
  index: number;
  ok: boolean;
  id?: number;
  error?: string;
}

/**
 * Create a batch of new posts from imported rows. `type` is the REST route base of the
 * target post type (defaults to `posts`). Returns a per-row result with the new id.
 */
export async function importPosts(
  creates: ImportCreateInput[],
  type = 'posts',
): Promise<ImportResult[]> {
  const res = await fetch('/api/posts/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, creates }),
  });
  const data = (await res.json().catch(() => ({}))) as { results?: ImportResult[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Import failed: ${res.status}`);
  }
  return Array.isArray(data.results) ? data.results : [];
}

/** A per-post meta deletion (delete the named keys from one post). */
export interface MetaDeletion {
  id: number;
  keys: string[];
}

/** Delete meta keys from many posts in one request (companion plugin required). */
export async function bulkDeleteMeta(deletes: MetaDeletion[]): Promise<UpdateResult[]> {
  const res = await fetch('/api/posts/meta/bulk', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deletes }),
  });
  const data = (await res.json().catch(() => ({}))) as { results?: UpdateResult[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Bulk delete failed: ${res.status}`);
  }
  return Array.isArray(data.results) ? data.results : [];
}
