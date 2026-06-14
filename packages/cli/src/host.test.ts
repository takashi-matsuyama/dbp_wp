import { describe, expect, it } from 'vitest';
import { isAllowedHost } from './host';

describe('isAllowedHost', () => {
  it('allows loopback hosts (with or without a port)', () => {
    expect(isAllowedHost('localhost')).toBe(true);
    expect(isAllowedHost('localhost:4317')).toBe(true);
    expect(isAllowedHost('127.0.0.1:4317')).toBe(true);
    expect(isAllowedHost('[::1]:4317')).toBe(true);
  });

  it('rejects non-loopback, missing, or malformed hosts', () => {
    expect(isAllowedHost('evil.example.com')).toBe(false);
    expect(isAllowedHost('evil.example.com:4317')).toBe(false);
    expect(isAllowedHost('127.0.0.1.evil.com')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost('')).toBe(false);
  });
});
