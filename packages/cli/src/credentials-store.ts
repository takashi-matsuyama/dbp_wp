import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import type { WpCredentials } from '@dbp-wp/core';

/**
 * Optional, opt-in persistence of WordPress credentials in OS secure storage.
 *
 * The application password (the only real secret) is stored in the macOS Keychain via the
 * `security` CLI; the non-secret siteUrl + username live in a plaintext config file so the UI
 * can show a "saved connection" without touching the Keychain. No third-party dependency is
 * used — the CLI keeps its zero-runtime-dependency footprint — and the password is written to
 * `security` over stdin, never as an argv (which would leak via `ps`).
 *
 * Only macOS is supported today. On other platforms the store degrades to a no-op (memory-only
 * operation still works); a later slice can add Linux/Windows backends behind this interface.
 */
export interface CredentialsStore {
  /** Whether this platform can persist credentials (macOS only for now). */
  isAvailable(): boolean;
  /** Load saved credentials, or null when none are saved or the platform is unsupported. */
  load(): Promise<WpCredentials | null>;
  /** Persist credentials. Rejects if saving fails, so the caller can report it. */
  save(credentials: WpCredentials): Promise<void>;
  /** Remove any saved credentials (both the Keychain entry and the config file). Never rejects. */
  clear(): Promise<void>;
  /** The non-secret part of a saved connection (siteUrl + username), or null if none saved. */
  peek(): Promise<StoredConnection | null>;
}

const DEFAULT_KEYCHAIN_SERVICE = 'dbp-wp';
// Single connection for now; this could become the siteUrl to support multiple saved sites.
const KEYCHAIN_ACCOUNT = 'default';

/** Keychain service name, overridable via DBP_WP_KEYCHAIN_SERVICE (used to isolate E2E tests). */
function keychainService(): string {
  return process.env.DBP_WP_KEYCHAIN_SERVICE?.trim() || DEFAULT_KEYCHAIN_SERVICE;
}

/** Dependencies injected for testability (real os/security by default). */
interface StoreDeps {
  configDir: string;
  service: string;
  runSecurity: (args: string[], stdin?: string) => Promise<string>;
}

/**
 * Default macOS config directory for the non-secret part of the saved connection. Overridable
 * via DBP_WP_CONFIG_DIR (useful for portable setups and for E2E tests that must not touch the
 * user's real config).
 */
function defaultConfigDir(): string {
  const override = process.env.DBP_WP_CONFIG_DIR?.trim();
  if (override) {
    return override;
  }
  return join(homedir(), 'Library', 'Application Support', 'dbp-wp');
}

/** Invoke the macOS `security` CLI, optionally writing `stdin`. Resolves stdout on success. */
function runSecurity(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // Pin the absolute path so a PATH-hijacked `security` can't receive the password on stdin.
    const child = execFile('/usr/bin/security', args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(stdout);
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

/** The non-secret part of a saved connection (the password lives only in the Keychain). */
export interface StoredConnection {
  siteUrl: string;
  username: string;
}

/** Parse the plaintext config file content, tolerating malformed or partial input. */
function parseStoredConnection(text: string): StoredConnection | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const fields = data as Record<string, unknown>;
  const siteUrl = typeof fields.siteUrl === 'string' ? fields.siteUrl : '';
  const username = typeof fields.username === 'string' ? fields.username : '';
  if (!siteUrl || !username) {
    return null;
  }
  return { siteUrl, username };
}

/** macOS backend: password in the Keychain, siteUrl + username in a plaintext config file. */
class MacKeychainStore implements CredentialsStore {
  constructor(private readonly deps: StoreDeps) {}

  private get configFile(): string {
    return join(this.deps.configDir, 'connection.json');
  }

  isAvailable(): boolean {
    return true;
  }

  private async readConfig(): Promise<StoredConnection | null> {
    try {
      return parseStoredConnection(await readFile(this.configFile, 'utf-8'));
    } catch {
      return null; // no config file → nothing saved
    }
  }

  async load(): Promise<WpCredentials | null> {
    const conn = await this.readConfig();
    if (!conn) {
      return null;
    }
    let applicationPassword: string;
    try {
      const out = await this.deps.runSecurity([
        'find-generic-password',
        '-a',
        KEYCHAIN_ACCOUNT,
        '-s',
        this.deps.service,
        '-w',
      ]);
      applicationPassword = out.replace(/\n$/, '');
    } catch {
      return null; // password missing/unreadable → treat as not saved
    }
    if (!applicationPassword) {
      return null;
    }
    return { siteUrl: conn.siteUrl, username: conn.username, applicationPassword };
  }

  async save(credentials: WpCredentials): Promise<void> {
    await mkdir(this.deps.configDir, { recursive: true, mode: 0o700 });
    try {
      // Write the secret (Keychain) first, then the non-secret pointer file. The password
      // goes over stdin twice (value + confirmation, as `security -w` prompts for) so it never
      // appears in this process's argv (which `ps` would expose). If either step fails, clear()
      // both: never leave a config pointing at a stale/foreign Keychain entry, which `useSaved`
      // could otherwise send to the wrong site.
      const pw = credentials.applicationPassword;
      await this.deps.runSecurity(
        ['add-generic-password', '-U', '-a', KEYCHAIN_ACCOUNT, '-s', this.deps.service, '-w'],
        `${pw}\n${pw}\n`,
      );
      const body = JSON.stringify({
        siteUrl: credentials.siteUrl,
        username: credentials.username,
      });
      await writeFile(this.configFile, body, { mode: 0o600 });
      // writeFile's mode only applies on create; tighten an already-existing file too.
      await chmod(this.configFile, 0o600);
    } catch (e) {
      await this.clear();
      throw e;
    }
  }

  async clear(): Promise<void> {
    // Delete the secret (Keychain) first, then the pointer file, so a forget that partially
    // fails never leaves the password behind while the app reports "nothing saved".
    try {
      await this.deps.runSecurity([
        'delete-generic-password',
        '-a',
        KEYCHAIN_ACCOUNT,
        '-s',
        this.deps.service,
      ]);
    } catch {
      // ignore: no entry to delete
    }
    try {
      await rm(this.configFile, { force: true });
    } catch {
      // ignore: nothing to remove
    }
  }

  async peek(): Promise<StoredConnection | null> {
    return this.readConfig();
  }
}

/** No-op store for unsupported platforms: opt-in persistence simply does nothing. */
class NoopStore implements CredentialsStore {
  isAvailable(): boolean {
    return false;
  }
  async load(): Promise<WpCredentials | null> {
    return null;
  }
  async save(): Promise<void> {
    // Persistence is unavailable on this platform; saving is a silent no-op (UI gates on
    // isAvailable() so this is not normally reached).
  }
  async clear(): Promise<void> {
    // Nothing is persisted on this platform.
  }
  async peek(): Promise<StoredConnection | null> {
    return null;
  }
}

/** Build the credentials store for the current platform (macOS → Keychain, otherwise no-op). */
export function createCredentialsStore(
  overrides: { platform?: string } & Partial<StoreDeps> = {},
): CredentialsStore {
  const platform = overrides.platform ?? osPlatform();
  if (platform !== 'darwin') {
    return new NoopStore();
  }
  return new MacKeychainStore({
    configDir: overrides.configDir ?? defaultConfigDir(),
    service: overrides.service ?? keychainService(),
    runSecurity: overrides.runSecurity ?? runSecurity,
  });
}
