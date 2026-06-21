/**
 * Connection credentials for a WordPress site.
 *
 * DBP WP authenticates with WordPress 5.6+ Application Passwords, which are sent as the
 * password of an HTTP Basic `Authorization` header.
 */
export interface WpCredentials {
  /** Base URL of the WordPress site, e.g. `https://example.com`. */
  siteUrl: string;
  /** WordPress username. */
  username: string;
  /** Application Password issued by WordPress (used as the Basic-auth password). */
  applicationPassword: string;
}

/**
 * Raw post shape as returned by the WordPress REST API (`/wp/v2/<type>`).
 *
 * `title` is an object; `raw` is only present in `context=edit`. `menu_order` is
 * snake_case. Use {@link WpPost} for the normalized internal model.
 */
export interface WpPostResponse {
  id: number;
  type: string;
  status: string;
  title: { rendered: string; raw?: string };
  menu_order: number;
  /** Featured image (attachment) ID; `0` when the post has no featured image. */
  featured_media?: number;
  meta: Record<string, unknown>;
  /**
   * Arbitrary post meta exposed by the companion plugin's `dbp_wp_meta` field.
   * Present only when the connector is active; absent in restricted mode.
   */
  dbp_wp_meta?: Record<string, unknown>;
  /** Rendered/raw content. Present when the request asks for it (e.g. Print Design). */
  content?: { rendered?: string; raw?: string };
  /** Rendered/raw excerpt. Present when the request asks for it. */
  excerpt?: { rendered?: string; raw?: string };
  /**
   * Embedded resources, present only when the request was made with `_embed`. Shapes are
   * intentionally loose (entries may be error objects); consumers validate at runtime.
   * `wp:featuredmedia` carries media objects; `wp:term` is an array of term-arrays.
   */
  _embedded?: {
    'wp:featuredmedia'?: unknown;
    'wp:term'?: unknown;
  };
}

/** Normalized, internal post model used by DBP WP. */
export interface WpPost {
  id: number;
  type: string;
  status: string;
  /** Editable title (the `raw` value when available, else `rendered`). */
  title: string;
  menuOrder: number;
  /**
   * Core REST post meta (only keys registered with `show_in_rest`). For arbitrary
   * meta exposed by the companion plugin, see {@link WpPost.dbpWpMeta}.
   */
  meta: Record<string, unknown>;
  /**
   * Arbitrary post meta from the companion plugin (all keys, single value each).
   * Present only when the connector returned `dbp_wp_meta`; `undefined` in restricted
   * mode (no connector installed).
   */
  dbpWpMeta?: Record<string, unknown>;
  /**
   * Parent post ID from the `_dbp_wp_parent` relation meta. Present only when the post
   * has a parent and the connector registered the key; `undefined` otherwise. The parent
   * post type's REST base is {@link WpPost.parentType}.
   */
  parent?: number;
  /**
   * Parent post type's REST route base from `_dbp_wp_parent_type`. Pairs with
   * {@link WpPost.parent}; `undefined` when the post has no parent.
   */
  parentType?: string;
  /**
   * Featured image (attachment) ID from the core `featured_media` field. Present only when
   * the post has a featured image (`featured_media > 0`); `undefined` otherwise. The image's
   * URL is resolved separately ({@link WpMedia}) so the listing stays lean.
   */
  featuredMedia?: number;
  /**
   * Assigned taxonomy term IDs keyed by the taxonomy's REST base (e.g. `terms.categories`,
   * `terms.tags`). A core REST field — no companion plugin needed. Term IDs are resolved to
   * names separately ({@link WpTerm}) so the listing stays lean. Always present (possibly an
   * empty map); a taxonomy with no assigned terms is an empty array or absent key.
   */
  terms: Record<string, number[]>;
}

/**
 * Editable standard post fields. These map to core WordPress REST fields and need no
 * companion plugin. Arbitrary meta editing is handled separately (companion plugin).
 */
export interface UpdatePostFields {
  /** Editable title (sent as the post `title`). */
  title?: string;
  /** Ordering value (sent as `menu_order`). */
  menuOrder?: number;
  /** Post status (e.g. `publish`, `draft`). */
  status?: string;
  /**
   * Featured image (attachment) ID (sent as `featured_media`). A core REST field — no
   * companion plugin needed. Pass `0` to remove the post's featured image.
   */
  featuredMedia?: number;
  /**
   * Post body HTML (sent as the core REST `content` field). Written by the single-post
   * body editor; an empty string clears the body. The standard listing/batch path never
   * sets this. No companion plugin needed.
   */
  content?: string;
  /**
   * Assigned taxonomy term IDs keyed by the taxonomy's REST base (e.g. `{ categories: [1, 2],
   * tags: [3] }`). Each taxonomy is sent as that REST field; an empty array clears the
   * post's terms for that taxonomy. A core REST field — no companion plugin needed.
   */
  terms?: Record<string, number[]>;
}

/**
 * A single post fetched for body editing. Carries the raw post body (`content.raw`) and,
 * when present, the lossless Markdown source from the `_dbp_wp_markdown` meta. The editor
 * picks its mode from {@link WpPostEdit.markdown}: a non-empty value means Markdown mode
 * (the source is editable and re-rendered to HTML), otherwise HTML mode (edit `content`
 * directly). Distinct from the lean {@link WpPost}, which omits the body.
 */
export interface WpPostEdit {
  id: number;
  type: string;
  status: string;
  /** Editable title (the `raw` value when available, else `rendered`). */
  title: string;
  /** Raw post body HTML (`content.raw`); the HTML that the front end renders. */
  content: string;
  /**
   * Lossless Markdown source from `_dbp_wp_markdown` (companion plugin). Present and
   * non-empty only for posts last saved in Markdown mode; `undefined` for HTML-mode posts
   * and in restricted mode (no connector). When present, `content` mirrors its rendered HTML.
   */
  markdown?: string;
}

/** A WordPress post type available for listing/editing over REST. */
export interface WpPostType {
  /** Internal type slug (e.g. `post`). */
  slug: string;
  /** REST route base used to list/update items of this type (e.g. `posts`). */
  restBase: string;
  /** Human-readable name (e.g. `Posts`). */
  name: string;
}

/** A WordPress taxonomy available over REST (e.g. categories, tags, custom taxonomies). */
export interface WpTaxonomy {
  /** Internal taxonomy slug (e.g. `category`). */
  slug: string;
  /** REST route base used to list terms and assign them on a post (e.g. `categories`). */
  restBase: string;
  /** Human-readable name (e.g. `Categories`). */
  name: string;
  /** Whether terms form a hierarchy (categories) rather than a flat list (tags). */
  hierarchical: boolean;
}

/** A normalized taxonomy term, as used by the taxonomy picker and the spreadsheet's columns. */
export interface WpTerm {
  /** Term ID. */
  id: number;
  /** Term name (display label). */
  name: string;
  /** Parent term ID for a hierarchical taxonomy; `0` (or absent) for a top-level/flat term. */
  parent: number;
}

/** Parameters for listing taxonomy terms. */
export interface ListTermsParams {
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Page size (WordPress caps this at 100). Defaults to 100. */
  perPage?: number;
  /** Free-text search across term names/slugs. */
  search?: string;
}

/** Result of a per-post meta delete via the companion plugin. */
export interface DeleteMetaResult {
  /** The post the keys were deleted from. */
  postId: number;
  /** Keys actually deleted (a key not present on the post is omitted). */
  deleted: string[];
}

/**
 * A normalized WordPress media (attachment) item, as used by the media picker and the
 * spreadsheet's featured-image column. Built from a raw `/wp/v2/media` response.
 */
export interface WpMedia {
  /** Attachment ID. */
  id: number;
  /** Full-size source URL of the media file (`''` when unavailable). */
  sourceUrl: string;
  /** Thumbnail-size URL when WordPress generated one; falls back to {@link WpMedia.sourceUrl}. */
  thumbnailUrl: string;
  /** Media title (rendered), or `''` when absent. */
  title: string;
  /** MIME type (e.g. `image/png`), or `''` when unknown. */
  mimeType: string;
}

/** Parameters for listing media (image attachments). */
export interface ListMediaParams {
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Page size (WordPress caps this at 100). Defaults to 30. */
  perPage?: number;
  /** Free-text search across media (title/filename). */
  search?: string;
}

/** Parameters for listing posts. */
export interface ListPostsParams {
  /** REST post type slug (e.g. `posts`, `pages`). Defaults to `posts`. */
  type?: string;
  /** Page size (WordPress caps this at 100). Defaults to 100. */
  perPage?: number;
  /** 1-based page number. Defaults to 1. */
  page?: number;
}
