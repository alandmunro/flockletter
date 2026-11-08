import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { commands, limits } from '../shared/contracts.js';

export type ApiCaller = (name: string, input: unknown) => Promise<unknown>;
export function apiCaller(origin: string, token: string): ApiCaller {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Use an exact HTTPS Flockletter origin, or local loopback HTTP.');
  if (!token.startsWith('flk_')) throw new Error('Use an owner-issued Flockletter connection token.');
  return async (name, input) => {
    const response = await fetch(`${origin}/api/v1/commands/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(60000) });
    const body = await response.json() as { result?: unknown; error?: { code: string; message: string; details?: unknown } };
    if (!response.ok) throw new Error(`${body.error?.code ?? 'request_failed'}: ${body.error?.message ?? 'Request failed.'}${body.error?.details ? ` ${JSON.stringify(body.error.details)}` : ''}`);
    return body.result;
  };
}
export function createMcpServer(call: ApiCaller, assetRoot?: string) {
  const server = new McpServer({ name: 'flockletter', version: '0.1.0' });
  const result = async (name: string, input: unknown) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await call(name, input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Request failed.' }] }; }
  };
  for (const [name, definition] of Object.entries(commands)) {
    if (definition.scope === 'owner') continue;
    server.registerTool(name.replace('.', '_'), {
      description: definition.description,
      inputSchema: definition.schema.shape,
      annotations: { readOnlyHint: !definition.mutation, destructiveHint: false, idempotentHint: true, openWorldHint: ['rehearsal.approve','rehearsal.process'].includes(name) },
    }, async (input: Record<string, unknown>) => result(name, definition.schema.parse(input)));
  }
  if (assetRoot) server.registerTool('asset_upload_files', {
    description: 'Batch-upload local original photos from the explicitly configured asset folder. Paths are relative to that folder. Stable per-file and operation keys support safe retries. No supplier downloads.',
    inputSchema: { operationKey: z.string(), brandId: z.uuid(), files: z.array(z.object({ itemKey: z.string(), path: z.string().min(1).max(1024) })).min(1).max(limits.batchFiles) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try {
      const root = await realpath(assetRoot);
      const files: { itemKey: string; name: string; base64: string }[] = [];
      let total = 0;
      for (const item of input.files) {
        if (path.isAbsolute(item.path)) throw new Error('Use paths relative to the configured asset folder.');
        const full = await realpath(path.resolve(root, item.path));
        if (!full.startsWith(root + path.sep)) throw new Error('An image is outside the configured asset folder.');
        const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > limits.fileBytes) throw new Error('Each input must be a regular image file no larger than 5 MiB.');
          const buffer = Buffer.alloc(limits.fileBytes + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.length) {
            const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (chunk.bytesRead === 0) break;
            bytesRead += chunk.bytesRead;
          }
          if (bytesRead > limits.fileBytes) throw new Error('An input image exceeds 5 MiB.');
          total += bytesRead;
          if (total > limits.batchBytes) throw new Error('The batch exceeds 20 MiB.');
          files.push({ itemKey: item.itemKey, name: path.basename(full), base64: buffer.subarray(0, bytesRead).toString('base64') });
        } finally { await file.close(); }
      }
      return result('asset.uploadBatch', { operationKey: input.operationKey, brandId: input.brandId, files });
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Photo preparation failed.' }] }; }
  });
  return server;
}
