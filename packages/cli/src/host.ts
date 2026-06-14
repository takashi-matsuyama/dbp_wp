// Only loopback hosts are allowed. Rejecting any other Host header blocks DNS
// rebinding attacks, which would otherwise let a remote page reach this local API
// through the victim's browser.
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True when the request's Host header names a loopback address. */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  return ALLOWED_HOSTS.has(hostname);
}

/**
 * True when the browser reports this as a cross-site request. Blocks a malicious page
 * from driving the local API (CSRF). Non-browser clients (curl, tests) omit the header
 * and are allowed.
 */
export function isCrossSiteRequest(secFetchSite: string | string[] | undefined): boolean {
  return secFetchSite === 'cross-site';
}

/** True when the Content-Type declares a JSON body. */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (typeof contentType !== 'string') {
    return false;
  }
  return contentType.split(';')[0]?.trim().toLowerCase() === 'application/json';
}
