import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import path from 'node:path';
import { isCommand, commands, plans } from '../shared/contracts.js';
import { AppError } from './errors.js';
import { configurationGaps, type Config } from './config.js';
import type { Authenticator } from './auth.js';
import { authorize, type CommandService } from './service.js';
import { subscriberRoutes } from './subscribers/routes.js';
import { marketingUnsubscribeRoutes } from './subscribers/marketing-routes.js';

export function createApp(config: Config, service?: CommandService, auth?: Authenticator) {
  const app = express();
  let activeUploads = 0;
  app.disable('x-powered-by');
  if (config.localIdentity) app.use((req, _res, next) => {
    const host = (req.get('host') ?? '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host ?? '')) return next(new AppError(403, 'host_rejected', 'Local development requires a loopback hostname.'));
    next();
  });
  // Render terminates TLS at one trusted reverse proxy. Local development trusts none.
  if (config.environment === 'staging') app.set('trust proxy', 1);
  let clerkOrigin: string | undefined;
  if (config.clerkPublishableKey) {
    const host = Buffer.from(config.clerkPublishableKey.split('_').slice(2).join('_'), 'base64').toString('utf8').replace(/\$$/, '');
    if (/^[A-Za-z0-9.-]+$/.test(host)) clerkOrigin = `https://${host}`;
  }
  // Clerk Protect runs its checks in the browser during hosted signup.
  const clerkScriptAndFrameHosts = clerkOrigin
    ? [clerkOrigin, 'https://challenges.cloudflare.com', 'https://*.protect.clerk.com']
    : [];
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", ...clerkScriptAndFrameHosts],
    connectSrc: ["'self'", ...(clerkOrigin ? [clerkOrigin, 'https://*.protect.clerk.com:*'] : [])],
    workerSrc: clerkOrigin ? ["'self'", 'blob:'] : ["'self'"],
    imgSrc: ["'self'", 'blob:', 'data:', 'https://img.clerk.com'],
    styleSrc: ["'self'", "'unsafe-inline'"], frameSrc: ["'self'", ...clerkScriptAndFrameHosts],
    objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"], upgradeInsecureRequests: config.environment === 'staging' ? [] : null,
  } }, crossOriginEmbedderPolicy: false, strictTransportSecurity: config.environment === 'staging' ? undefined : false }));
  app.get('/healthz', (_req, res) => res.json({ status: 'alive' }));
  app.get('/readyz', async (_req, res) => {
    const gaps = configurationGaps(config);
    if (!service || !auth) gaps.push('service_not_ready');
    if (service) { try { await service.db.verifyBoundary(); } catch { gaps.push('database_unavailable'); } }
    res.status(gaps.length ? 503 : 200).json({ ready: gaps.length === 0, gaps, sendingEnabled: false });
  });
  app.get('/api/config', (_req, res) => res.json({ environment: config.environment, localIdentity: config.localIdentity, clerkPublishableKey: config.clerkPublishableKey ?? null, setupGaps: configurationGaps(config), plans, sendingEnabled: false }));
  app.use('/api/v1', rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    skip: req => (['HEAD','POST'].includes(req.method) && /^\/brands\/[^/]+\/subscriber-signups\/?$/i.test(req.path)) ||
      (req.method==='POST' && /^\/(confirmation-feedback|billing\/stripe-events)\/?$/i.test(req.path)),
    message: { error: { code: 'rate_limited', message: 'Too many requests. Retry in a minute.' } } }));
  app.use('/api/v1', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin && !config.browserOrigins.includes(origin)) return next(new AppError(403, 'origin_rejected', 'This browser origin is not authorized.'));
    if (req.get('sec-fetch-site') === 'cross-site') return next(new AppError(403, 'origin_rejected', 'Cross-site browser requests are not authorized.'));
    if (!service || !auth) return next(new AppError(503, 'setup_required', 'Workspace operations require the Flockletter database and Clerk backend connection.'));
    next();
  });
  subscriberRoutes(app, config, service?.intake, auth);
  marketingUnsubscribeRoutes(app,config,service?.db);
  app.post('/api/v1/billing/stripe-events',rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false}),express.raw({type:'application/json',limit:'128kb'}),async(req,res)=>{
    if(!Buffer.isBuffer(req.body)) throw new AppError(415,'json_required','Send the raw signed Stripe event.');
    await service!.billing.feedback(req.body,req.get('stripe-signature')??'');
    res.json({received:true});
  });
  app.get('/api/v1/connection/identity', async (req,res)=>{
    const actor=await auth!.authenticate(req);
    if(actor.kind!=='connection'||actor.scopes.includes('subscriber:signup')) throw new AppError(403,'connection_required','Use a preparation connection to inspect its own identity.');
    res.json({id:actor.actorId.slice('connection:'.length),workspaceId:actor.workspaceId,brandIds:actor.brandIds,scopes:actor.scopes});
  });
  app.get('/api/v1/schema', async (req, res) => {
    const actor=await auth!.authenticate(req);
    if (actor.scopes.includes('subscriber:signup')) throw new AppError(403,'scope_required','This connection only accepts subscriber signups.');
    res.json({ version: 'v1', commands: Object.fromEntries(Object.entries(commands).map(([name, c]) => [name, { description: c.description, requiredScope: c.scope, mutation: c.mutation, inputSchema: c.schema.toJSONSchema({io:'input'}) }])) });
  });
  app.post('/api/v1/commands/:name', async (req, res, next) => {
    // Authenticate before parsing a potentially large upload.
    const actor = await auth!.authenticate(req);
    if (!req.is('application/json')) throw new AppError(415, 'json_required', 'Send application/json.');
    const name = String(req.params.name);
    if (!isCommand(name)) throw new AppError(404, 'unknown_command', 'This command is unavailable. Sending and billing are not enabled.');
    authorize(actor, name);
    if (name === 'asset.uploadBatch') {
      if (activeUploads >= 2) throw new AppError(429, 'upload_busy', 'Two image batches are already being processed. Retry this batch shortly with the same keys.');
      activeUploads++;
      let released = false;
      const release = () => { if (!released) { activeUploads--; released = true; } };
      res.once('finish', release); res.once('close', release);
    }
    const limit = name==='asset.uploadBatch' ? '29mb' : name==='audience.previewImport' ? '350kb' : name.startsWith('audience.') ? '4kb' : '64kb';
    express.json({ limit, strict: true })(req, res, error => {
      if (error) return next(error);
      void service!.execute(name, req.body, actor).then(result => res.json({ result })).catch(next);
    });
  });
  app.get('/api/v1/assets/:id', async (req, res) => {
    const actor = await auth!.authenticate(req);
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw new AppError(404, 'not_found', 'This image is unavailable.');
    const asset = await service!.readAsset(actor, String(req.params.id));
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Content-Disposition', 'inline');
    res.type(asset.mime).send(asset.bytes);
  });
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'not_found', 'This API route is unavailable.')));
  const clientDirectory = path.resolve('dist/client');
  app.use(express.static(clientDirectory, { index: false, maxAge: '1h' }));
  app.get('/{*path}', (_req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(clientDirectory, 'index.html')); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof AppError) return void res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    if (error instanceof ZodError) return void res.status(422).json({ error: { code: 'invalid_input', message: 'Review the highlighted input requirements.', details: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) } });
    const status = (error as { status?: number })?.status;
    if (status === 415) return void res.status(415).json({error:{code:'unsupported_encoding',message:'Use an uncompressed JSON body.'}});
    if (status === 413 || status === 400) return void res.status(status).json({ error: { code: status === 413 ? 'request_too_large' : 'invalid_json', message: status === 413 ? 'This request is too large. Split the batch.' : 'Send valid JSON.' } });
    // Never return provider responses, request bodies, connection strings or tokens.
    res.status(500).json({ error: { code: 'service_error', message: 'The operation could not finish. Retry with the same operation key.' } });
  };
  app.use(errors);
  return app;
}
