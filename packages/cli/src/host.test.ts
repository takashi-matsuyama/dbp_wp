import { describe, expect, it } from 'vitest';
import { isAllowedHost, isCrossSiteRequest, isJsonContentType } from './host';

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

describe('isCrossSiteRequest', () => {
  it('flags only cross-site fetch metadata', () => {
    expect(isCrossSiteRequest('cross-site')).toBe(true);
  });

  it('allows same-origin, same-site, none, or absent metadata', () => {
    expect(isCrossSiteRequest('same-origin')).toBe(false);
    expect(isCrossSiteRequest('same-site')).toBe(false);
    expect(isCrossSiteRequest('none')).toBe(false);
    expect(isCrossSiteRequest(undefined)).toBe(false);
  });
});

describe('isJsonContentType', () => {
  it('accepts application/json with or without parameters', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('APPLICATION/JSON')).toBe(true);
  });

  it('rejects other or missing content types', () => {
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('text/plain;application/json')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});
