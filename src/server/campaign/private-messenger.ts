import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler } from 'express';
import { limits } from '../../shared/contracts.js';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import { captureBinding } from './worker.js';
import type { CheckOwner } from './rehearsal.js';
import type { SesRuntime } from './ses-runtime.js';
import { PrivateListmonk } from './private-listmonk.js';

export function privateMessenger(secret: string, receive: (message: unknown) => Promise<void>) {
  const app = express();
  app.disable('x-powered-by');
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const expected = hash('Basic ' + Buffer.from('flockletter:' + secret).toString('base64'));
  let receiving = false;
  app.post(
    '/message',
    (req, res, next) => {
      if (!timingSafeEqual(expected, hash(req.get('authorization') ?? ''))) {
        res.sendStatus(401);
        return;
      }
      if (!req.is('application/json')) {
        res.sendStatus(415);
        return;
      }
      if (receiving) {
        res.sendStatus(503);
        return;
      }
      receiving = true;
      const release = () => {
        receiving = false;
        res.removeListener('close', release);
        res.removeListener('finish', release);
      };
      res.once('close', release);
      res.once('finish', release);
      next();
    },
    express.json({
      limit: Math.ceil((limits.campaignImages * limits.fileBytes) / 3) * 4 + 1024 * 1024,
      inflate: false,
    }),
    async (req, res) => {
      await receive(req.body);
      res.sendStatus(200); // Listmonk 6.2 requires 200 after the callback is durably stored.
    },
  );
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status =
      error instanceof AppError
        ? error.status
        : error?.type === 'entity.too.large'
          ? 413
          : error?.type === 'entity.parse.failed'
            ? 400
            : error?.type === 'encoding.unsupported'
              ? 415
              : 503;
    res.status(status).end();
  };
  app.use(errors);
  return app;
}
export async function startPrivateMessenger(
  db: Database,
  checkOwner: CheckOwner,
  ses: SesRuntime | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!env.FLOCKLETTER_PRIVATE_ENGINE || env.FLOCKLETTER_PRIVATE_ENGINE === 'off') return;
  const scope = captureBinding(env);
  if (env.FLOCKLETTER_PRIVATE_ENGINE !== 'embedded' || env.APP_ENV !== 'staging' || !scope)
    throw Error('Configure one explicit staging workspace and brand for the private engine.');
  const { EmbeddedListmonk } = await import('./embedded-listmonk.js');
  const secret = randomBytes(32).toString('hex');
  const server = createServer(privateMessenger(secret, (body) => dispatcher.receive(body)));
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const engine = new EmbeddedListmonk('http://127.0.0.1:' + port + '/message', secret);
  const dispatcher = new PrivateListmonk(db, checkOwner, scope, engine, ses);
  return {
    dispatcher,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await engine.close();
      await closed;
    },
  };
}
