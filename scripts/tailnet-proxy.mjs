// Tailscale Serve terminates private HTTPS and forwards to this loopback listener.
// Keep the destination fixed. Browser-provided hosts and absolute URLs cannot select an upstream.
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';
import { URL } from 'node:url';

function exactHttpsOrigin(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.hostname.includes('*')) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  return url;
}

const upstream = exactHttpsOrigin(process.env.FLOCKLETTER_STAGING_ORIGIN, 'FLOCKLETTER_STAGING_ORIGIN');
const tailnet = exactHttpsOrigin(process.env.FLOCKLETTER_TAILNET_ORIGIN, 'FLOCKLETTER_TAILNET_ORIGIN');
const port = Number(process.env.FLOCKLETTER_PROXY_PORT ?? '4311');
if (!Number.isInteger(port) || port < 1 || port > 65535 || upstream.origin === tailnet.origin) {
  throw new Error('Use a valid loopback port and a distinct upstream staging origin.');
}

const requestHeaders = new Set([
  'accept', 'accept-encoding', 'accept-language', 'authorization', 'content-length', 'content-type',
  'if-modified-since', 'if-none-match', 'origin', 'referer', 'sec-fetch-dest', 'sec-fetch-mode',
  'sec-fetch-site', 'user-agent',
]);
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

const server = http.createServer((incoming, outgoing) => {
  if (incoming.headers.host !== tailnet.host) {
    outgoing.writeHead(421).end();
    return;
  }
  if (!['GET', 'HEAD', 'POST'].includes(incoming.method) || !incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
    outgoing.writeHead(400).end();
    return;
  }
  const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => requestHeaders.has(name)));
  const relay = https.request({
    hostname: upstream.hostname,
    port: upstream.port || 443,
    path: incoming.url,
    method: incoming.method,
    headers: { ...headers, host: upstream.host },
    timeout: 90000,
  }, response => {
    const forwarded = { ...response.headers };
    const connectionHeaders = (forwarded.connection ?? '').split(',').map(name => name.trim().toLowerCase());
    for (const name of [...hopHeaders, ...connectionHeaders]) delete forwarded[name];
    outgoing.writeHead(response.statusCode ?? 502, forwarded);
    response.on('error', () => outgoing.destroy());
    response.pipe(outgoing);
  });
  relay.on('timeout', () => relay.destroy());
  relay.on('error', () => {
    if (outgoing.headersSent) return outgoing.destroy();
    outgoing.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    outgoing.end('Flockletter staging is temporarily unavailable. Please retry.');
  });
  outgoing.on('close', () => { if (!outgoing.writableEnded) relay.destroy(); });
  incoming.on('error', () => relay.destroy());
  incoming.pipe(relay);
});

server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
