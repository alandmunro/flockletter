import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import type { SubscriberIntake } from './intake.js';
import { authorizeIntake } from './intake.js';
import { applyFeedback } from '../confirmation/feedback.js';

const actions = z.enum(['confirm', 'unsubscribe']);
export function subscriberRoutes(
  app: Express,
  config: Config,
  intake?: SubscriberIntake,
  auth?: Authenticator,
) {
  app.post(
    '/api/v1/brands/:brandId/subscriber-signups',
    async (req, _res, next) => {
      if (!intake || !auth)
        throw new AppError(503, 'intake_unavailable', 'Subscriber intake is unavailable.');
      if (req.get('origin') || req.get('sec-fetch-site') || (config.environment === 'staging' && !req.secure))
        throw new AppError(403, 'server_only', 'Use a secure server-to-server request.');
      if (!req.get('authorization')?.startsWith('Bearer flk_'))
        throw new AppError(401, 'intake_credential_required', 'Use a subscriber intake credential.');
      const actor = await auth.authenticate(req);
      const brand = z.uuid().safeParse(req.params.brandId);
      if (!brand.success) throw new AppError(404, 'brand_unavailable', 'The requested brand is unavailable.');
      authorizeIntake(actor, brand.data);
      if (!req.is('application/json')) throw new AppError(415, 'json_required', 'Send application/json.');
      _res.locals.intakeActor = actor;
      next();
    },
    express.json({ limit: 8192, strict: true, inflate: false }),
    async (req, res) => {
      res
        .status(202)
        .json(
          await intake!.signup(
            res.locals.intakeActor,
            String(req.params.brandId),
            req.get('idempotency-key'),
            req.body,
          ),
        );
    },
  );
  app.post(
    '/api/v1/confirmation-feedback',
    express.raw({ type: 'application/json', limit: '32kb', inflate: false }),
    async (req, res) => {
      if (!intake) throw new AppError(503, 'feedback_unavailable', 'Confirmation feedback is unavailable.');
      if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'json_required', 'Send application/json.');
      await applyFeedback(intake, req.body, {
        'webhook-id': req.get('svix-id') ?? '',
        'webhook-signature': req.get('svix-signature') ?? '',
        'webhook-timestamp': req.get('svix-timestamp') ?? '',
      });
      res.sendStatus(204);
    },
  );
  app.use(
    '/subscriptions',
    rateLimit({
      windowMs: 60000,
      limit: 60,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message: 'Too many requests. Try again later.' } },
    }),
    (_req, res, next) => {
      res.set({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
      });
      next();
    },
  );
  app.get('/subscriptions/:action', (req, res) => {
    if (!actions.safeParse(req.params.action).success)
      throw new AppError(404, 'not_found', 'This link is unavailable.');
    const confirm = req.params.action === 'confirm';
    const title = confirm ? 'Confirm your subscription' : 'Unsubscribe from these emails';
    const body = confirm
      ? 'Choose Confirm to receive product news and occasional promotions from Frosty Flamingo Apparel.'
      : 'Choose Unsubscribe to stop product emails from Frosty Flamingo Apparel.';
    res
      .type('html')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | Flockletter</title><link rel="stylesheet" href="/subscriber-action.css"><script src="/subscriber-action.js" defer></script></head><body><header>Flockletter<img src="/brand/frosty-flamingo-software.png" alt="Frosty Flamingo Software"></header><main><h1>${title}</h1><p>${body}</p><form><button type="submit" disabled>${confirm ? 'Confirm subscription' : 'Unsubscribe'}</button></form><p id="status" role="status"></p><noscript>Enable JavaScript to use this confirmation form.</noscript></main></body></html>`,
      );
  });
  app.post(
    '/subscriptions/:action',
    (req, _res, next) => {
      if (req.get('origin') !== config.origin)
        throw new AppError(403, 'origin_rejected', 'Use the original Flockletter link.');
      if (!req.is('application/json')) throw new AppError(415, 'json_required', 'Send application/json.');
      next();
    },
    express.json({ limit: 1024, strict: true, inflate: false }),
    async (req, res) => {
      const action = actions.safeParse(req.params.action);
      const body = z
        .object({ token: z.string().max(160) })
        .strict()
        .safeParse(req.body);
      if (!action.success || !body.success)
        throw new AppError(400, 'invalid_link', 'This link is unavailable.');
      if (!intake) throw new AppError(503, 'intake_unavailable', 'This action is currently unavailable.');
      res.json(await intake.act(action.data, body.data.token));
    },
  );
}
