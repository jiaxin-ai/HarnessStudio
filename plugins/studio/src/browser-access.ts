import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';

export const name = 'harnessstudio-browser-access';
export const inject = ['connection'];

export interface Config { mode: 'anonymous' | 'token' }
export const Config: z<Config> = z.object({ mode: z.union(['anonymous', 'token']).default('anonymous') });

/**
 * Compose the product's anonymous browser policy over Connection's public
 * admission methods. The official carrier, Client module, registries, request
 * limits and operator Peer remain owned by DSH. No prototype or upstream file
 * is changed; unloading restores the instance's original method descriptors.
 *
 * The pinned Connection rejects untrusted Host/Origin with 403 before checking
 * the browser cookie (401). Only that browser authentication result is removed.
 */
export function installAnonymousBrowserAccess(connection: HostConnectionHandle): () => void {
  const originalRejection = connection.requestRejection.bind(connection);
  const requestRejection: HostConnectionHandle['requestRejection'] = request => {
    const rejection = originalRejection(request);
    return rejection === 401 ? undefined : rejection;
  };
  const authorizeIndex: HostConnectionHandle['authorizeIndex'] = (request, response) => {
    const rejection = requestRejection(request);
    if (rejection !== undefined) {
      response.writeHead(rejection, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : 'forbidden\n');
      return false;
    }
    // Old bookmarked token URLs still open, but remove their now-unused token
    // without exchanging it for a Cookie. Relative redirects also support mounts.
    const url = new URL(request.url ?? '/', 'http://studio.invalid');
    if (url.searchParams.has('token')) {
      url.searchParams.delete('token');
      response.writeHead(303, { location: './' + url.search, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end();
      return false;
    }
    return true;
  };
  const authenticatedUrl: HostConnectionHandle['authenticatedUrl'] = baseUrl => {
    const url = new URL(baseUrl);
    url.searchParams.delete('token');
    return url.href;
  };
  const methods = { requestRejection, authorizeIndex, authenticatedUrl };
  const originals = new Map<keyof typeof methods, PropertyDescriptor | undefined>();
  for (const method of Object.keys(methods) as (keyof typeof methods)[]) originals.set(method, Object.getOwnPropertyDescriptor(connection, method));
  for (const method of Object.keys(methods) as (keyof typeof methods)[]) {
    Object.defineProperty(connection, method, { value: methods[method], configurable: true, writable: true });
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const [method, descriptor] of originals) {
      // Do not overwrite a later composition which took ownership of a method.
      if (Object.getOwnPropertyDescriptor(connection, method)?.value !== methods[method]) continue;
      if (descriptor) Object.defineProperty(connection, method, descriptor);
      else Reflect.deleteProperty(connection, method);
    }
  };
}

export function apply(ctx: Context, config: Config): void {
  if (config.mode === 'anonymous') ctx.effect(() => installAnonymousBrowserAccess(ctx.connection), 'studio: anonymous browser admission');
}
