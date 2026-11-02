/** Validate a software platform endpoint against the deployment's exact HTTP opt-ins.
 * Returns the normalized origin, or '' when the endpoint is not configured. */
export function seatOrigin(endpoint: string, trustedHttpOrigins: unknown): string {
  // This is a deployment-owned opt-in, not a general insecure transport flag.
  // Validate even unused entries so a typo cannot silently broaden trust.
  const configured = trustedHttpOrigins ?? [];
  if (!Array.isArray(configured) || configured.length > 100) throw new Error('trustedHttpOrigins must be an array of at most 100 exact HTTP origins');
  const trusted = new Set(configured.map(value => {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('trustedHttpOrigins must contain exact HTTP origins');
    let origin: URL;
    try { origin = new URL(value); } catch { throw new Error('trustedHttpOrigins must contain exact HTTP origins'); }
    if (origin.protocol !== 'http:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || origin.hostname.includes('*') || (value !== origin.origin && value !== `${origin.origin}/`)) throw new Error('trustedHttpOrigins must contain exact HTTP origins without credentials, paths, queries, fragments or wildcards');
    return origin.origin;
  }));
  if (!endpoint) return '';
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol) || !/^https?:\/\/[^/?#\\]+\/?$/i.test(endpoint)) throw new Error('Seat endpoint must be an origin');
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && !trusted.has(url.origin)) throw new Error('Remote Seat endpoint requires HTTPS or an explicitly trusted HTTP origin');
  return url.origin;
}
