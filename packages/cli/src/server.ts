import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';
import { WpClient, type WpCredentials } from '@dbp-wp/core';
import { isAllowedHost } from './host';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface ServerOptions {
  /** WordPress credentials, or null to run in skeleton mode (empty results). */
  credentials: WpCredentials | null;
  /** Absolute path to the built UI `dist` directory, or null when not built. */
  uiDir: string | null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  res.end(message);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServerOptions,
): Promise<void> {
  try {
    if (req.method === 'GET' && url.pathname === '/api/posts') {
      if (!options.credentials) {
        sendJson(res, 200, { posts: [], unconfigured: true });
        return;
      }
      const client = new WpClient(options.credentials);
      const type = url.searchParams.get('type');
      const pageRaw = url.searchParams.get('page');
      const page = pageRaw ? Number.parseInt(pageRaw, 10) : undefined;
      const posts = await client.listPosts({
        ...(type ? { type } : {}),
        ...(page && page > 0 ? { page } : {}),
      });
      sendJson(res, 200, { posts, unconfigured: false });
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: e instanceof Error ? e.message : 'Upstream request failed' });
    }
  }
}

/** Resolve a request path to a file inside uiDir, or null if it escapes the root. */
function resolveSafe(uiDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = resolve(uiDir, '.' + (decoded === '/' ? '/index.html' : decoded));
  const rel = relative(uiDir, candidate);
  if (rel === '') {
    // The request resolved to uiDir itself; serve its index.
    return join(uiDir, 'index.html');
  }
  if (rel.startsWith('..') || resolve(uiDir, rel) !== candidate) {
    return null;
  }
  return candidate;
}

/** Stream a file to the response with an error handler so failures never crash. */
function pipeFile(res: ServerResponse, filePath: string, contentType: string): void {
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    } else {
      res.destroy();
    }
  });
  res.writeHead(200, { 'Content-Type': contentType });
  stream.pipe(res);
}

async function serveStatic(
  res: ServerResponse,
  uiDir: string | null,
  pathname: string,
): Promise<void> {
  if (!uiDir) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(notBuiltPage());
    return;
  }

  const filePath = resolveSafe(uiDir, pathname);
  if (!filePath) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  if (await statFile(filePath)) {
    pipeFile(res, filePath, MIME[extname(filePath)] ?? 'application/octet-stream');
    return;
  }

  // SPA fallback: serve index.html for extension-less routes; otherwise 404.
  if (extname(pathname) === '') {
    const indexPath = join(uiDir, 'index.html');
    if (await statFile(indexPath)) {
      pipeFile(res, indexPath, 'text/html; charset=utf-8');
      return;
    }
  }
  sendError(res, 404, 'Not found');
}

async function statFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function notBuiltPage(): string {
  return [
    '<!doctype html><meta charset="utf-8"><title>DBP WP</title>',
    '<body style="font-family:system-ui;padding:2rem">',
    '<h1>DBP WP</h1>',
    '<p>The UI has not been built yet. Run <code>npm run build</code> and restart.</p>',
    '</body>',
  ].join('');
}

/** Create the local HTTP server: serves the UI and a small JSON API. */
export function createDbpServer(options: ServerOptions): Server {
  return createServer((req, res) => {
    // Reject non-loopback Host headers (DNS rebinding protection).
    if (!isAllowedHost(req.headers.host)) {
      sendError(res, 403, 'Forbidden');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      void handleApi(req, res, url, options).catch(() => sendError(res, 500, 'Internal error'));
      return;
    }
    void serveStatic(res, options.uiDir, url.pathname).catch(() =>
      sendError(res, 500, 'Internal error'),
    );
  });
}
