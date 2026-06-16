import type {
  ConnectInput,
  ConnectionStatus,
  ImportCreateInput,
  ImportResult,
  ListPostsQuery,
  MediaListResult,
  MetaDeletion,
  PostUpdate,
  PostsResponse,
  PrintRecordsResponse,
  UpdateResult,
} from './api.types';
import type { WpMedia, WpPost, WpPostType } from '@dbp-wp/core';

// The CLI-backed data layer. The UI talks only to the local CLI server (`/api/...`), never
// to WordPress directly, so the browser never holds credentials and is not subject to
// cross-origin rules. This is the default build; the browser demo swaps in `api.local.ts`.

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

/** Build the local API path for listing Print Design records. Exported for unit testing. */
export function printPostsPath(query: ListPostsQuery = {}): string {
  const params = new URLSearchParams();
  if (query.type) {
    params.set('type', query.type);
  }
  if (query.page && query.page > 1) {
    params.set('page', String(query.page));
  }
  const qs = params.toString();
  return qs ? `/api/print/posts?${qs}` : '/api/print/posts';
}

/** Fetch posts flattened for Print Design (content/excerpt + featured image + terms). */
export async function fetchPrintRecords(query: ListPostsQuery = {}): Promise<PrintRecordsResponse> {
  const res = await fetch(printPostsPath(query));
  if (!res.ok) {
    throw new Error(`Failed to load print records: ${res.status}`);
  }
  const data = (await res.json()) as Partial<PrintRecordsResponse>;
  return {
    records: Array.isArray(data.records) ? data.records : [],
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

/**
 * Set a child post's parent via the CLI's `/api/relation` route (companion plugin
 * required). The relation rides the standard `meta` field server-side.
 */
export async function setRelation(
  childId: number,
  childType: string,
  parentId: number,
  parentType: string,
): Promise<WpPost> {
  return relationRequest({ childId, childType, parentId, parentType }, 'Set relation');
}

/** Clear a child post's parent (sends `parentId: null`, which deletes the relation meta). */
export async function clearRelation(childId: number, childType: string): Promise<WpPost> {
  return relationRequest({ childId, childType, parentId: null }, 'Clear relation');
}

/** Shared POST to `/api/relation`; the CLI sets or clears based on `parentId`. */
async function relationRequest(body: Record<string, unknown>, label: string): Promise<WpPost> {
  const res = await fetch('/api/relation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { post?: WpPost; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `${label} failed: ${res.status}`);
  }
  return data.post as WpPost;
}

/** Build the local API path for listing/searching media. Exported for unit testing. */
export function mediaListPath(query: { page?: number; search?: string } = {}): string {
  const params = new URLSearchParams();
  if (query.page && query.page > 1) {
    params.set('page', String(query.page));
  }
  if (query.search && query.search.trim() !== '') {
    params.set('search', query.search.trim());
  }
  const qs = params.toString();
  return qs ? `/api/media?${qs}` : '/api/media';
}

/**
 * Upload an image to the media library. The browser sends the raw file bytes (not JSON);
 * the filename rides the required `X-DBP-Filename` header (percent-encoded so non-ASCII
 * names survive), which the CLI also uses as a CSRF preflight guard for this binary route.
 */
export async function uploadMedia(file: File): Promise<WpMedia> {
  const res = await fetch('/api/media', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-DBP-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as { media?: WpMedia; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Upload failed: ${res.status}`);
  }
  return data.media as WpMedia;
}

/** List image attachments for the media picker (paginated, optionally searched). */
export async function listMedia(
  query: { page?: number; search?: string } = {},
): Promise<MediaListResult> {
  const res = await fetch(mediaListPath(query));
  if (!res.ok) {
    throw new Error(`Failed to load media: ${res.status}`);
  }
  const data = (await res.json()) as Partial<MediaListResult>;
  return {
    items: Array.isArray(data.items) ? data.items : [],
    totalPages: typeof data.totalPages === 'number' && data.totalPages > 0 ? data.totalPages : 1,
  };
}

/** Resolve specific media ids to their URLs (for featured-image thumbnails in the grid). */
export async function resolveMedia(ids: number[]): Promise<WpMedia[]> {
  if (ids.length === 0) {
    return [];
  }
  const res = await fetch(`/api/media?include=${ids.join(',')}`);
  if (!res.ok) {
    throw new Error(`Failed to resolve media: ${res.status}`);
  }
  const data = (await res.json()) as { items?: WpMedia[] };
  return Array.isArray(data.items) ? data.items : [];
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
