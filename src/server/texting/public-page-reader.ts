import { Resolver } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as tlsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { safeLink } from '../content.js';

const maxBytes = 256 * 1024;
const deny4 = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['168.63.129.16', 32], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) deny4.addSubnet(address, bits, 'ipv4');

const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const deny6 = new BlockList();
for (const [address, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const)
  deny6.addSubnet(address, bits, 'ipv6');

export function isPublicPageAddress(address: string) {
  if (isIP(address) === 4) return !deny4.check(address, 'ipv4');
  return isIP(address) === 6 && global6.check(address, 'ipv6') && !deny6.check(address, 'ipv6');
}

const unavailable = () => new Error('Page unavailable.');
type Response = { html: string } | { redirect: string };
type Resolve = (hostname: string, signal: AbortSignal) => Promise<string[]>;
type Get = (url: URL, address: string, signal: AbortSignal) => Promise<Response>;

async function resolvePublic(hostname: string, signal: AbortSignal) {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const resolve = async (query: Promise<string[]>) => {
      try { return await query; } catch (error) {
        if (['ENOTFOUND', 'ENODATA'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
        throw error;
      }
    };
    const [a, aaaa] = await Promise.all([resolve(resolver.resolve4(hostname)), resolve(resolver.resolve6(hostname))]);
    return [...a, ...aaaa];
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function getPage(url: URL, address: string, signal: AbortSignal): Promise<Response> {
  const https = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const req = (https ? tlsRequest : httpRequest)({
      // Connect to the address we inspected. Keep the original hostname for TLS verification and HTTP routing.
      hostname: address, port: Number(url.port || (https ? 443 : 80)), servername: url.hostname, agent: false,
      path: url.pathname + url.search, signal, maxHeaderSize: 16 * 1024,
      headers: { Host: url.host, Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'Flockletter-Enrollment/1' },
    }, response => {
      response.once('error', reject);
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        resolve({ redirect: response.headers.location });
        response.destroy();
        return;
      }
      if (status !== 200 || !/^text\/html(?:;|$)/i.test(response.headers['content-type'] ?? '') ||
          (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') ||
          Number(response.headers['content-length']) > maxBytes) {
        reject(unavailable()); response.destroy(); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { reject(unavailable()); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end();
  });
}

function checkedSite(url: URL) {
  if (!safeLink(url.href) || url.hash || url.hostname.endsWith('.') || url.href.length > 1500) throw unavailable();
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

/** Only the explicitly supplied server-owned URLs can use the application's own origin. */
export function enrollmentPageReader(ownOrigin: string, ownPages: ReadonlySet<string>, resolve: Resolve = resolvePublic, get: Get = getPage) {
  return async (raw: string): Promise<string> => {
    let url = new URL(raw);
    const owned = url.origin === ownOrigin;
    if (owned && !ownPages.has(url.href)) throw unavailable();
    // The development server can use loopback HTTP, exclusively for our stored signup and policy routes.
    const local = owned && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    const originalSite = local ? '' : checkedSite(url);
    const signal = AbortSignal.timeout(6500);
    for (let hop = 0; hop <= 2; hop++) {
      signal.throwIfAborted();
      const addresses = local ? ['127.0.0.1'] : await resolve(url.hostname, signal);
      if (!addresses.length || (!local && !addresses.every(isPublicPageAddress))) throw unavailable();
      const result = await get(url, addresses[0]!, signal);
      if ('html' in result) return result.html;
      if (owned || hop === 2) throw unavailable();
      url = new URL(result.redirect, url);
      if (url.origin === ownOrigin || checkedSite(url) !== originalSite) throw unavailable();
    }
    throw unavailable();
  };
}
