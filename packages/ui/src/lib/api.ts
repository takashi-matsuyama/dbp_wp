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
