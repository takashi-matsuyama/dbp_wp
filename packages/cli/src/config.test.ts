import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, readCredentials, readPort } from './config';

describe('readCredentials', () => {
  it('returns null when any field is missing', () => {
    expect(readCredentials({})).toBeNull();
    expect(
      readCredentials({ DBP_WP_SITE_URL: 'https://x.com', DBP_WP_USERNAME: 'editor' }),
    ).toBeNull();
  });

  it('returns trimmed credentials when all fields are present', () => {
    expect(
      readCredentials({
        DBP_WP_SITE_URL: ' https://x.com ',
        DBP_WP_USERNAME: ' editor ',
        DBP_WP_APP_PASSWORD: ' abcd efgh ',
      }),
    ).toEqual({ siteUrl: 'https://x.com', username: 'editor', applicationPassword: 'abcd efgh' });
  });
});

describe('readPort', () => {
  it('falls back to the default for missing or invalid values', () => {
    expect(readPort({})).toBe(DEFAULT_PORT);
    expect(readPort({ DBP_WP_CLI_PORT: 'abc' })).toBe(DEFAULT_PORT);
    expect(readPort({ DBP_WP_CLI_PORT: '0' })).toBe(DEFAULT_PORT);
    expect(readPort({ DBP_WP_CLI_PORT: '99999' })).toBe(DEFAULT_PORT);
  });

  it('uses a valid port', () => {
    expect(readPort({ DBP_WP_CLI_PORT: '8080' })).toBe(8080);
  });
});
