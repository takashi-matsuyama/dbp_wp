import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  parseCredentialsInput,
  parseRememberFlag,
  parseUseSaved,
  readCredentials,
  readPort,
} from './config';

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
    expect(readPort({ DBP_WP_CLI_PORT: '3000x' })).toBe(DEFAULT_PORT);
    expect(readPort({ DBP_WP_CLI_PORT: '80.5' })).toBe(DEFAULT_PORT);
  });

  it('uses a valid port, trimming surrounding whitespace', () => {
    expect(readPort({ DBP_WP_CLI_PORT: '8080' })).toBe(8080);
    expect(readPort({ DBP_WP_CLI_PORT: ' 8080 ' })).toBe(8080);
  });
});

describe('parseCredentialsInput', () => {
  it('returns null for non-objects or missing fields', () => {
    expect(parseCredentialsInput(null)).toBeNull();
    expect(parseCredentialsInput('nope')).toBeNull();
    expect(parseCredentialsInput({ siteUrl: 'https://x.com', username: 'a' })).toBeNull();
    expect(
      parseCredentialsInput({ siteUrl: 'https://x.com', username: 'a', applicationPassword: '  ' }),
    ).toBeNull();
  });

  it('returns trimmed credentials when all fields are valid strings', () => {
    expect(
      parseCredentialsInput({
        siteUrl: ' https://x.com ',
        username: ' editor ',
        applicationPassword: ' abcd efgh ',
      }),
    ).toEqual({ siteUrl: 'https://x.com', username: 'editor', applicationPassword: 'abcd efgh' });
  });
});

describe('parseRememberFlag', () => {
  it('is true only for an explicit boolean true', () => {
    expect(parseRememberFlag({ remember: true })).toBe(true);
  });

  it('defaults to false for missing, falsy, or non-boolean values', () => {
    expect(parseRememberFlag({})).toBe(false);
    expect(parseRememberFlag({ remember: false })).toBe(false);
    expect(parseRememberFlag({ remember: 'true' })).toBe(false);
    expect(parseRememberFlag({ remember: 1 })).toBe(false);
    expect(parseRememberFlag(null)).toBe(false);
    expect(parseRememberFlag('nope')).toBe(false);
  });
});

describe('parseUseSaved', () => {
  it('is true only for an explicit boolean true', () => {
    expect(parseUseSaved({ useSaved: true })).toBe(true);
  });

  it('defaults to false for missing, falsy, or non-boolean values', () => {
    expect(parseUseSaved({})).toBe(false);
    expect(parseUseSaved({ useSaved: false })).toBe(false);
    expect(parseUseSaved({ useSaved: 'true' })).toBe(false);
    expect(parseUseSaved(null)).toBe(false);
    expect(parseUseSaved('nope')).toBe(false);
  });
});
