# @dbp-wp/core

Core library for [DBP WP](https://github.com/takashi-matsuyama/dbp_wp): a WordPress REST
client, a safe formula engine, a CSV/JSON importer, and typesetting data generation.

This package is the Node layer of DBP WP. Most people will want the `dbp-wp` CLI, which
runs the full app via `npx dbp-wp`. This library is published separately so it can also be
used on its own and by the browser demo.

```sh
npm install @dbp-wp/core
```

```ts
import { WpClient } from '@dbp-wp/core';

const client = new WpClient({
  siteUrl: 'https://example.com',
  username: 'editor',
  applicationPassword: 'xxxx xxxx xxxx xxxx xxxx xxxx',
});

const posts = await client.listPosts({ perPage: 20 });
```

Requires Node.js >= 20.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
