import type {
  PrintRecord,
  WpMedia,
  WpPost,
  WpPostEdit,
  WpPostType,
  WpTaxonomy,
  WpTerm,
} from '@dbp-wp/core';

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
  /** Whether this platform can persist credentials to OS secure storage (macOS only). */
  canPersist: boolean;
  /** Whether a saved connection currently exists in secure storage. */
  persisted: boolean;
  /** The siteUrl of the saved connection (for the "use saved" prompt), or null. */
  savedSiteUrl: string | null;
}

export interface ConnectInput {
  siteUrl: string;
  username: string;
  applicationPassword: string;
  /** Opt-in: persist these credentials to OS secure storage on a successful connection. */
  remember?: boolean;
}

export interface PostUpdate {
  id: number;
  title?: string;
  menuOrder?: number;
  status?: string;
  /** Featured image (attachment) id; `0` removes it. A core REST field (no connector). */
  featuredMedia?: number;
  /**
   * Taxonomy term IDs keyed by REST base (e.g. `{ categories: [1, 2] }`); an empty array clears
   * that taxonomy. A core REST field (no connector).
   */
  terms?: Record<string, number[]>;
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

/** A single-post body save from the editor (content HTML + optional Markdown source). */
export interface PostBodyUpdate {
  /** Post body HTML to write to `content` (`''` clears the body). */
  content: string;
  /**
   * Markdown source: a string sets it (Markdown mode), `null` clears it (demoting a
   * previously-Markdown post to HTML mode), and omitting it leaves the meta untouched
   * (HTML-only post). Setting/clearing requires the companion plugin.
   */
  markdown?: string | null;
}

/** A page of media-library results, with the total page count for the picker's pager. */
export interface MediaListResult {
  items: WpMedia[];
  totalPages: number;
}

/** A page of taxonomy-term results, with the total page count for the picker's pager. */
export interface TermListResult {
  items: WpTerm[];
  totalPages: number;
}

/**
 * The data layer the UI depends on. Both the CLI client and the local demo store implement
 * this exact surface so the views are identical in either build.
 */
export interface ApiImpl {
  getConnection(): Promise<ConnectionStatus>;
  connect(input: ConnectInput): Promise<ConnectionStatus>;
  /** Connect using credentials saved in OS secure storage (no password in the browser). */
  connectSaved(): Promise<ConnectionStatus>;
  disconnect(): Promise<void>;
  /** Erase any saved credentials from OS secure storage. */
  forget(): Promise<void>;
  fetchTypes(): Promise<WpPostType[]>;
  fetchPosts(query?: ListPostsQuery): Promise<PostsResponse>;
  /** Fetch one post for body editing: the raw `content` plus the Markdown source (full mode). */
  fetchPost(id: number, type: string): Promise<WpPostEdit>;
  /** Save one post's body (content + optional Markdown source). Returns the persisted post. */
  savePostBody(id: number, type: string, update: PostBodyUpdate): Promise<WpPostEdit>;
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
  /** Upload an image to the media library and return the created item (core REST, no connector). */
  uploadMedia(file: File): Promise<WpMedia>;
  /** List image attachments for the media picker, paginated/searchable (core REST). */
  listMedia(query?: { page?: number; search?: string }): Promise<MediaListResult>;
  /** Resolve specific media ids to their URLs (to fill featured-image thumbnails). */
  resolveMedia(ids: number[]): Promise<WpMedia[]>;
  /** List the taxonomies applicable to a post type (categories, tags, custom). Core REST. */
  fetchTaxonomies(type: string): Promise<WpTaxonomy[]>;
  /** List a taxonomy's terms for the picker, paginated/searchable (core REST). */
  fetchTerms(taxonomy: string, query?: { page?: number; search?: string }): Promise<TermListResult>;
  /**
   * Fetch every term of a taxonomy, for building a hierarchy tree client-side (core REST).
   * `truncated` is true when a page cap stopped short of a very large taxonomy.
   */
  fetchAllTerms(
    taxonomy: string,
    query?: { search?: string },
  ): Promise<{ items: WpTerm[]; truncated: boolean }>;
  /** Resolve specific term ids to their names (to label the taxonomy columns). Core REST. */
  resolveTerms(taxonomy: string, ids: number[]): Promise<WpTerm[]>;
  /** Create a new taxonomy term, optionally under a parent (hierarchical). Core REST. */
  createTerm(taxonomy: string, input: { name: string; parent?: number }): Promise<WpTerm>;
}
