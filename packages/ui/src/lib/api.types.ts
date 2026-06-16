import type { PrintRecord, WpPost, WpPostType } from '@dbp-wp/core';

// Shared data types and the data-layer interface. Two implementations satisfy `ApiImpl`:
// `api.cli.ts` (the real CLI-backed `/api` client) and `api.local.ts` (the browser demo's
// local, network-free store). `api.ts` picks one at build time.

export interface ListPostsQuery {
  type?: string;
  page?: number;
}

export interface PostsResponse {
  posts: WpPost[];
  /** True when the CLI has no WordPress credentials configured yet (skeleton mode). */
  unconfigured: boolean;
}

export interface PrintRecordsResponse {
  records: PrintRecord[];
  /** True when the CLI has no WordPress credentials configured yet (skeleton mode). */
  unconfigured: boolean;
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

/** A per-post meta deletion (delete the named keys from one post). */
export interface MetaDeletion {
  id: number;
  keys: string[];
}

/**
 * The data layer the UI depends on. Both the CLI client and the local demo store implement
 * this exact surface so the views are identical in either build.
 */
export interface ApiImpl {
  getConnection(): Promise<ConnectionStatus>;
  connect(input: ConnectInput): Promise<ConnectionStatus>;
  disconnect(): Promise<void>;
  fetchTypes(): Promise<WpPostType[]>;
  fetchPosts(query?: ListPostsQuery): Promise<PostsResponse>;
  savePosts(updates: PostUpdate[], type?: string): Promise<UpdateResult[]>;
  importPosts(creates: ImportCreateInput[], type?: string): Promise<ImportResult[]>;
  bulkDeleteMeta(deletes: MetaDeletion[]): Promise<UpdateResult[]>;
  fetchPrintRecords(query?: ListPostsQuery): Promise<PrintRecordsResponse>;
  /** Set a child post's parent (companion plugin required). Returns the updated post. */
  setRelation(
    childId: number,
    childType: string,
    parentId: number,
    parentType: string,
  ): Promise<WpPost>;
  /** Clear a child post's parent (companion plugin required). Returns the updated post. */
  clearRelation(childId: number, childType: string): Promise<WpPost>;
}
