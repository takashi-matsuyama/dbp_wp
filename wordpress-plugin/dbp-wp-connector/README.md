# DBP WP Connector

An optional WordPress plugin that lets the [DBP WP](https://github.com/takashi-matsuyama/dbp_wp)
app read, edit, and delete **custom post meta** over the REST API, and that records
**parent/child relations** between posts. Protected/internal meta (keys for which
WordPress' `is_protected_meta()` is true — by default `_`-prefixed keys such as
`_edit_lock`, `_thumbnail_id`, `_wp_*`) is excluded from the custom-meta operations; the
relation keys are the deliberate, individually-registered exception (see below).

WordPress core only exposes meta registered with `show_in_rest`. Without this
connector the app runs in a restricted mode (standard fields only); with it
installed and activated, the app can work with any custom field.

The connector adds **no authentication of its own**. Requests authenticate with
WordPress core [Application Passwords](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/),
and every operation is gated by the same `edit_post` capability check WordPress
applies when editing the target post.

- **License:** GPL-2.0-or-later (the app itself is Apache-2.0; this plugin links
  against GPL WordPress code and follows the WordPress-ecosystem convention).
- **Requires:** WordPress 5.6+ (Application Passwords), PHP 7.4+.

## Installation

Copy the `dbp-wp-connector/` directory into `wp-content/plugins/` on the target
site and activate it from **Plugins**.

## REST API

### `dbp_wp_meta` field (read / write)

The connector registers a `dbp_wp_meta` field on every REST-enabled post type,
available only in the `edit` context. It rides the standard post routes the app
already uses, so meta travels with the post in a single round-trip.

**Read** — `GET /wp-json/wp/v2/<type>/<id>?context=edit` (or the collection route)
includes:

```jsonc
{
  "id": 123,
  "dbp_wp_meta": { "price": "1980", "sku": "A-1980" }
}
```

Every non-protected meta key is returned as a flat `{ key: value }` map (single value
per key). Multi-value meta keys are out of scope for now — only the first value is
returned. Protected/internal meta (`is_protected_meta()`, e.g. `_`-prefixed core keys)
is omitted.

**Write** — `POST /wp-json/wp/v2/<type>/<id>` with:

```jsonc
{ "dbp_wp_meta": { "price": "2480" } }
```

upserts each provided key (`update_post_meta`). Only scalar values (string,
number, boolean, or `null`) are written; non-scalar values are skipped. Protected
meta keys (`is_protected_meta()`) are also skipped.

### Delete by key (per post)

`DELETE /wp-json/dbp-wp/v1/posts/<id>/meta`

```jsonc
{ "keys": ["price", "sku"] }
```

Deletes the named (non-protected) meta keys from **that one post** and returns:

```jsonc
{ "post_id": 123, "deleted": ["price"] }
```

Deletion is intentionally per-post. The connector does **not** replicate the
legacy site-wide delete-by-key behaviour, which removed a key across every post.
The `<id>` must be a normal post; revision and autosave IDs are rejected (400).

### Parent/child relations (standard `meta` field)

The connector registers two single-valued meta keys on every REST-enabled post type
via `register_post_meta()`, so they appear in the **standard core `meta` field** (not
`dbp_wp_meta`):

- `_dbp_wp_parent` — the parent post's ID (integer, `absint`).
- `_dbp_wp_parent_type` — the parent post type's REST route base (string, validated
  against `^[a-z0-9_-]+$`).

Only the **child** stores these keys — the single source of truth. The app derives a
parent's children client-side, so there is no denormalized child list to keep in sync.

**Set** — `POST /wp-json/wp/v2/<childType>/<childId>`:

```jsonc
{ "meta": { "_dbp_wp_parent": 42, "_dbp_wp_parent_type": "pages" } }
```

**Clear** — send `null` for both keys; WordPress deletes the meta:

```jsonc
{ "meta": { "_dbp_wp_parent": null, "_dbp_wp_parent_type": null } }
```

Both keys are `_`-prefixed (protected). They are reachable over REST only because they
are individually registered with `show_in_rest` and an `auth_callback` that delegates to
`current_user_can( 'edit_post', $childId )` — the same per-post gate as every other
operation. No other protected meta is exposed.

## Detection from the app

The app detects the connector by fetching `GET /wp-json/` on connect and checking
whether `dbp-wp/v1` appears in the response's `namespaces` array — no dedicated
endpoint is required.
