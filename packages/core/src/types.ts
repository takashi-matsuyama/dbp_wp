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

/** Result of a per-post meta delete via the companion plugin. */
export interface DeleteMetaResult {
  /** The post the keys were deleted from. */
  postId: number;
  /** Keys actually deleted (a key not present on the post is omitted). */
  deleted: string[];
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
