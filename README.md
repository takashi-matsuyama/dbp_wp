# DBP WP

A local-first editor for WordPress. Edit post bodies in Markdown or HTML without opening
wp-admin, bulk-edit across many posts in a spreadsheet, and typeset print-ready PDFs — all
from a lightweight `npx` app. Built for the headless-CMS era.

Its **core is single-post body editing**: open a post and write in Markdown or HTML with a
live preview — a lightweight alternative to the full-page, plugin-heavy block editor. Around
that core, a spreadsheet view bulk-edits many posts at once, and Print Design turns HTML + CSS
into print-ready PDFs.

DBP WP talks directly to your own WordPress site using the WordPress REST API and
[Application Passwords](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/).
Your data stays in your WordPress install; the app keeps only local settings.

## Architecture

DBP WP is a three-layer monorepo, so the distribution shell can change without rewriting
the application:

| Package          | Role                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `@dbp-wp/core`   | Node library: WordPress REST client, formula engine, importer, typesetting data generation (npm).      |
| `@dbp-wp/ui`     | Shell-agnostic Web SPA (Svelte 5): table view and spreadsheet.                                             |
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
