import type { WpCredentials } from '@dbp-wp/core';

/** Default localhost port for the CLI server. */
export const DEFAULT_PORT = 4317;

/**
 * Read WordPress credentials from the environment. Returns null unless all three
 * fields are present, so the app can run in skeleton mode without a connection.
 */
export function readCredentials(env: NodeJS.ProcessEnv = process.env): WpCredentials | null {
  const siteUrl = env.DBP_WP_SITE_URL?.trim();
  const username = env.DBP_WP_USERNAME?.trim();
  const applicationPassword = env.DBP_WP_APP_PASSWORD?.trim();
  if (!siteUrl || !username || !applicationPassword) {
    return null;
  }
  return { siteUrl, username, applicationPassword };
}

/**
 * Parse credentials submitted over the API. Returns null unless all three fields are
 * present non-empty strings. Input is untrusted, so the shape is validated explicitly.
 */
export function parseCredentialsInput(body: unknown): WpCredentials | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const fields = body as Record<string, unknown>;
  const siteUrl = typeof fields.siteUrl === 'string' ? fields.siteUrl.trim() : '';
  const username = typeof fields.username === 'string' ? fields.username.trim() : '';
  const applicationPassword =
    typeof fields.applicationPassword === 'string' ? fields.applicationPassword.trim() : '';
  if (!siteUrl || !username || !applicationPassword) {
    return null;
  }
  return { siteUrl, username, applicationPassword };
}

/** Resolve the server port from the environment, falling back to {@link DEFAULT_PORT}. */
export function readPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DBP_WP_CLI_PORT;
  if (!raw) {
    return DEFAULT_PORT;
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return DEFAULT_PORT;
  }
  return port;
}
