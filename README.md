# DBP WP

A local-first app for bulk-editing WordPress content over the REST API — spreadsheet-style
editing, table views, CSV/JSON import, and print-ready (CSS) typesetting.

DBP WP talks directly to your own WordPress site using the WordPress REST API and
[Application Passwords](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/).
Your data stays in your WordPress install; the app keeps only local settings.

## Architecture

DBP WP is a three-layer monorepo, so the distribution shell can change without rewriting
the application:

| Package          | Role                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `@dbp-wp/core`   | Node library: WordPress REST client, formula engine, importer, typesetting data generation (npm).      |
| `@dbp-wp/ui`     | Shell-agnostic Web SPA (React): table view and spreadsheet.                                             |
| `dbp-wp` (CLI)   | `npx` shell: starts a localhost server, serves the UI, and opens the browser.                          |

Credentials and WordPress requests stay in the Node process (CLI), so the browser UI never
holds secrets and is not subject to cross-origin restrictions.

## Quick start (development)

```sh
npm install
npm run build
npm test
npm run dev      # run the UI in development
```

Requires Node.js >= 20.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
