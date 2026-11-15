import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function testHostedConnection(token: string) {
  const client = new Client({ name: 'flockletter-connection-test', version: '1' });
  const endpoint = new URL('/api/v1/mcp', window.location.origin);
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: 'Bearer ' + token }, redirect: 'error' },
    }));
    return (await client.listTools()).tools.length;
  } finally { await client.close(); }
}
