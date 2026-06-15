# @dbp-wp/ui

The web UI for [DBP WP](https://github.com/takashi-matsuyama/dbp_wp): a shell-agnostic
single-page app (Svelte 5) providing the table view and spreadsheet.

This package ships a prebuilt, self-contained SPA in `dist/`. It is served as static files
by the `dbp-wp` CLI, which is what most people will run (`npx dbp-wp`). The UI talks to the
CLI's local API, so it never holds WordPress credentials of its own.

It is published as a sibling package (alongside `@dbp-wp/core` and `dbp-wp`) so the three
layers — core, UI, and shell — stay independently versioned.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
