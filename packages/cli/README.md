# dbp-wp

A local-first app to bulk-edit WordPress content over the REST API — spreadsheet-style
editing, table views, CSV/JSON import, and (coming) print-ready CSS typesetting.

```sh
npx dbp-wp
```

This starts a local server on `127.0.0.1`, serves the web UI, and opens it in your
browser. Connect to your own WordPress site with its URL, your username, and an
[Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/).

## How it works

- Your data stays in your own WordPress install. The app talks directly to it over the
  WordPress REST API; there is no third-party server.
- Credentials and WordPress requests stay in the local Node process. The browser UI never
  holds secrets and is not subject to cross-origin restrictions.
- Credentials are kept in memory only and are never written to disk. You can also seed a
  connection from the environment (`DBP_WP_SITE_URL`, `DBP_WP_USERNAME`,
  `DBP_WP_APP_PASSWORD`).

## Modes

- **Full mode** — with the optional [companion plugin](https://github.com/takashi-matsuyama/dbp_wp)
  (`dbp-wp-connector`) installed, you can edit and bulk-delete arbitrary post meta.
- **Restricted mode** — without the plugin, standard REST fields (title, menu order,
  status) still work.

## Configuration

| Variable             | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `DBP_WP_CLI_PORT`    | Port to listen on (default `4317`).                 |
| `DBP_WP_SITE_URL`    | Seed an initial connection (with the two below).    |
| `DBP_WP_USERNAME`    | WordPress username.                                 |
| `DBP_WP_APP_PASSWORD`| WordPress Application Password.                      |

Requires Node.js >= 20.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
