import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readCredentials, readPort } from './config';
import { openBrowser } from './open-browser';
import { createDbpServer } from './server';

/**
 * Locate the built UI assets. Works both in the workspace (symlinked package) and
 * when installed from npm, as long as `@dbp-wp/ui` ships its `dist` directory.
 */
function resolveUiDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@dbp-wp/ui/package.json');
    const dist = join(dirname(pkgPath), 'dist');
    if (existsSync(join(dist, 'index.html'))) {
      return dist;
    }
  } catch {
    // Package not resolvable yet (e.g. UI not built); fall back to skeleton page.
  }
  return null;
}

function main(): void {
  // Credentials live in memory only; the env vars seed an initial connection.
  const state = { credentials: readCredentials() };
  const port = readPort();
  const uiDir = resolveUiDir();

  const server = createDbpServer({ state, uiDir });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `Port ${port} is already in use. Set DBP_WP_CLI_PORT to choose another port.\n`,
      );
    } else if (err.code === 'EACCES') {
      process.stderr.write(`Permission denied binding port ${port}. Try a port >= 1024.\n`);
    } else {
      process.stderr.write(`Server error: ${err.message}\n`);
    }
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    process.stdout.write(`DBP WP is running at ${url}\n`);
    if (!state.credentials) {
      process.stdout.write(
        'No WordPress connection yet; connect from the browser UI (or set DBP_WP_SITE_URL / DBP_WP_USERNAME / DBP_WP_APP_PASSWORD).\n',
      );
    }
    if (!uiDir) {
      process.stdout.write('UI assets not found; run `npm run build` first.\n');
    }
    openBrowser(url);
  });
}

main();
