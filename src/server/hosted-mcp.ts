import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../mcp/bridge.js';
import type { Authenticator } from './auth.js';
import { AppError } from './errors.js';
import { authorize, type CommandService } from './service.js';

export function hostedMcp(service: CommandService, auth: Authenticator) {
  const router = express.Router();
  router.post('/', async (req, res) => {
    if (!req.get('authorization')?.startsWith('Bearer flk_')) {
      res.set('WWW-Authenticate', 'Bearer realm="Flockletter"');
      throw new AppError(401, 'connection_required', 'Use a Flockletter connection token.');
    }
    const actor = await auth.authenticate(req);
    if (actor.kind !== 'connection' || actor.scopes.includes('subscriber:signup')) {
      throw new AppError(403, 'connection_required', 'Use a workspace assistant connection.');
    }
    if (!req.is('application/json')) throw new AppError(415, 'json_required', 'Send application/json.');
    // Authenticate before reading JSON. Files from the client machine use the local bridge.
    await new Promise<void>((resolve, reject) => {
      express.json({ limit: '1mb' })(req, res, error => error ? reject(error) : resolve());
    });
    const server = createMcpServer(async (name, input) => {
      try { return await service.execute(name, input, actor); }
      catch (cause) {
        if (cause instanceof AppError) throw new Error(cause.code + ': ' + cause.message, { cause });
        throw new Error('The request could not be completed.', { cause });
      }
    }, undefined, name => {
      try { authorize(actor, name); return true; }
      catch (cause) { if (cause instanceof AppError) return false; throw cause; }
    });
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally { await server.close(); }
  });
  router.all('/', (_req, res) => { res.set('Allow', 'POST').sendStatus(405); });
  return router;
}
