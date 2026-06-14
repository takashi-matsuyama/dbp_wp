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
   * Post meta. Arbitrary-key meta editing requires the companion plugin; core REST only
   * exposes meta registered with `show_in_rest`.
   */
  meta: Record<string, unknown>;
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
