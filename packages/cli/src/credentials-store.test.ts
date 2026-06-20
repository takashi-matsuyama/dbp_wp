import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCredentialsStore } from './credentials-store';

// A stateful fake of the macOS `security` CLI: an in-memory keychain plus a call log so tests
// can assert how it was invoked (notably that the password rides stdin, never argv).
function makeFakeSecurity() {
  const calls: Array<{ args: string[]; stdin: string | undefined }> = [];
  let stored: string | null = null;
  const run = async (args: string[], stdin?: string): Promise<string> => {
    calls.push({ args, stdin });
    switch (args[0]) {
      case 'add-generic-password':
        // The real CLI prompts twice (value + confirmation); take the first line.
        stored = stdin ? (stdin.split('\n')[0] ?? '') : '';
        return '';
      case 'find-generic-password':
        if (stored === null) {
          throw new Error('SecKeychainSearchCopyNext: item could not be found');
        }
        return `${stored}\n`; // security appends a trailing newline
      case 'delete-generic-password':
        if (stored === null) {
          throw new Error('item could not be found');
        }
        stored = null;
        return 'password has been deleted.\n';
      default:
        throw new Error(`unexpected security subcommand: ${args[0]}`);
    }
  };
  return { run, calls, peek: () => stored };
}

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbp-cs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SAMPLE = {
  siteUrl: 'https://example.com',
  username: 'editor',
  // WordPress Application Passwords are space-separated; verify spaces survive the round-trip.
  applicationPassword: 'abcd EFGH 1234 wxyz',
};

describe('createCredentialsStore on macOS', () => {
  it('is available on darwin', () => {
    const store = createCredentialsStore({ platform: 'darwin', configDir: '/tmp/x', runSecurity: async () => '' });
    expect(store.isAvailable()).toBe(true);
  });

  it('saves the password over stdin (never in argv) and only non-secret fields to disk', async () => {
    const fake = makeFakeSecurity();
    const dir = await makeTempDir();
    const store = createCredentialsStore({ platform: 'darwin', configDir: dir, runSecurity: fake.run });

    await store.save(SAMPLE);

    // The config file holds only siteUrl + username — never the password.
    const config = JSON.parse(await readFile(join(dir, 'connection.json'), 'utf-8'));
    expect(config).toEqual({ siteUrl: SAMPLE.siteUrl, username: SAMPLE.username });

    const add = fake.calls.find((c) => c.args[0] === 'add-generic-password');
    expect(add).toBeDefined();
    expect(add?.args).not.toContain(SAMPLE.applicationPassword); // not leaked via argv/ps
    expect(add?.stdin).toBe(`${SAMPLE.applicationPassword}\n${SAMPLE.applicationPassword}\n`);
    expect(fake.peek()).toBe(SAMPLE.applicationPassword);
  });

  it('round-trips: load returns the saved credentials (trimming the trailing newline)', async () => {
    const fake = makeFakeSecurity();
    const dir = await makeTempDir();
    const store = createCredentialsStore({ platform: 'darwin', configDir: dir, runSecurity: fake.run });

    await store.save(SAMPLE);
    expect(await store.load()).toEqual(SAMPLE);
    expect(await store.peek()).toEqual({ siteUrl: SAMPLE.siteUrl, username: SAMPLE.username });
  });

  it('load returns null when no config file exists', async () => {
    const fake = makeFakeSecurity();
    const dir = await makeTempDir();
    const store = createCredentialsStore({ platform: 'darwin', configDir: dir, runSecurity: fake.run });
    expect(await store.load()).toBeNull();
    expect(await store.peek()).toBeNull();
  });

  it('load returns null when the keychain entry is missing even if the config exists', async () => {
    const fake = makeFakeSecurity(); // stored stays null
    const dir = await makeTempDir();
    await writeFile(join(dir, 'connection.json'), JSON.stringify({ siteUrl: SAMPLE.siteUrl, username: SAMPLE.username }));
    const store = createCredentialsStore({ platform: 'darwin', configDir: dir, runSecurity: fake.run });
    expect(await store.load()).toBeNull();
  });

  it('treats malformed or partial config as nothing saved', async () => {
    const fake = makeFakeSecurity();
    const dir = await makeTempDir();
    const store = createCredentialsStore({ platform: 'darwin', configDir: dir, runSecurity: fake.run });

    await writeFile(join(dir, 'connection.json'), 'not json');
    expect(await store.load()).toBeNull();
    expect(await store.peek()).toBeNull();

    await writeFile(join(dir, 'connection.json'), JSON.stringify({ siteUrl: SAMPLE.siteUrl })); // no username
    expect(await store.load()).toBeNull();
    expect(await store.peek()).toBeNull();
  });

  it('clear removes both the config file and the keychain entry', async () => {
    const fake = makeFakeSecurity();
    const dir = await makeTempDir();
    const store = createCredentialsStore({ platform: 'darwin', configDir: dir, runSecurity: fake.run });

    await store.save(SAMPLE);
    await store.clear();

    expect(existsSync(join(dir, 'connection.json'))).toBe(false);
    expect(fake.peek()).toBeNull();
    expect(await store.peek()).toBeNull();
  });

  it('clear never rejects when nothing is saved', async () => {
    const fake = makeFakeSecurity();
    const dir = await makeTempDir();
    const store = createCredentialsStore({ platform: 'darwin', configDir: dir, runSecurity: fake.run });
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('on a keychain failure, save() clears partial state (no stale config left behind)', async () => {
    const dir = await makeTempDir();
    // A security that fails only on add; delete (during the rollback clear) still succeeds.
    const runSecurity = async (args: string[]): Promise<string> => {
      if (args[0] === 'add-generic-password') {
        throw new Error('keychain locked');
      }
      return '';
    };
    const store = createCredentialsStore({ platform: 'darwin', configDir: dir, runSecurity });
    await expect(store.save(SAMPLE)).rejects.toThrow();
    // No stale config pointing at a Keychain entry that was never written.
    expect(existsSync(join(dir, 'connection.json'))).toBe(false);
    expect(await store.peek()).toBeNull();
  });
});

describe('createCredentialsStore on unsupported platforms', () => {
  it('degrades to a no-op on non-darwin', async () => {
    const store = createCredentialsStore({ platform: 'linux' });
    expect(store.isAvailable()).toBe(false);
    expect(await store.load()).toBeNull();
    await expect(store.save(SAMPLE)).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
    expect(await store.peek()).toBeNull();
  });
});
