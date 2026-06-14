import type { WpPost } from '@dbp-wp/core';

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
  return (await res.json()) as PostsResponse;
}

export interface ConnectionStatus {
  connected: boolean;
  siteUrl: string | null;
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
  return (await res.json()) as ConnectionStatus;
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
  return { connected: data.connected ?? true, siteUrl: data.siteUrl ?? input.siteUrl };
}

/** Clear the CLI's in-memory credentials. */
export async function disconnect(): Promise<void> {
  const res = await fetch('/api/connection', { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Disconnect failed: ${res.status}`);
  }
}
