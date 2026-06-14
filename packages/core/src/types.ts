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

/** A WordPress post, narrowed to the fields DBP WP edits. */
export interface WpPost {
  id: number;
  type: string;
  status: string;
  title: string;
  menuOrder: number;
  /** Post meta. Arbitrary-key editing requires the companion plugin (see planning Q2). */
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
