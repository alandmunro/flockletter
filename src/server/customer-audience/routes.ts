import express, { type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { CustomerAudience } from './service.js';
import { redeemCustomerOptOut } from './service.js';
import { AppError } from '../errors.js';

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
function protect(res: Response) {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
}
const page = (heading: string, body: string) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
  escape(heading) +
  ' | Flockletter</title><link rel="stylesheet" href="/subscriber-action.css"></head><body><header>Flockletter<img src="/brand/frosty-flamingo-software.png" alt="Frosty Flamingo Software"></header><main><h1>' +
  escape(heading) +
  '</h1>' +
  body +
  '</main></body></html>';
export function customerAudienceRoutes(service: CustomerAudience) {
  const router = express.Router();
  router.use((req, res, next) => {
    protect(res);
    const origin = req.get('origin'),
      site = req.get('sec-fetch-site');
    // Chromium uses an opaque Origin on native forms under no-referrer. Fetch metadata
    // still proves a same-origin navigation; browser scripts cannot forge these headers.
    const opaqueNativeForm=origin==='null'&&site==='same-origin'&&req.get('sec-fetch-mode')==='navigate';
    if (
      req.method === 'POST' &&
      ((origin && origin !== service.options.origin&&!opaqueNativeForm) || (site && site !== 'same-origin'))
    )
      return next(new AppError(403, 'origin_rejected', 'Use the form on this site.'));
    next();
  });
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: { message: 'Too many requests. Try again shortly.' } },
    }),
  );
  router.use(express.urlencoded({ extended: false, limit: '8kb' }));
  router.get('/opt-out', (req, res) => {
    const token = typeof req.query.t === 'string' && req.query.t.length < 1000 ? req.query.t : '';
    res
      .type('html')
      .send(
        page(
          'Unsubscribe',
          '<p>Stop newsletters from this sending brand.</p><form method="post"><input type="hidden" name="token" value="' +
            escape(token) +
            '"><button type="submit">Unsubscribe</button></form>',
        ),
      );
  });
  router.post('/opt-out', async (req, res) => {
    const token =
      typeof req.body?.token === 'string'
        ? req.body.token
        : typeof req.query.t === 'string'
          ? req.query.t
          : '';
    if (req.body?.['List-Unsubscribe'] === 'One-Click') {
      await redeemCustomerOptOut(service.db, token);
      res.status(204).end();
      return;
    }
    await redeemCustomerOptOut(service.db, token);
    res
      .type('html')
      .send(
        page('Request received', '<p>Marketing for this brand is stopped for an eligible subscription.</p>'),
      );
  });
  router.get('/:form/confirm', async (req, res) => {
    const form = await service.publicForm(String(req.params.form));
    const token = typeof req.query.t === 'string' && req.query.t.length === 80 ? req.query.t : '';
    res
      .type('html')
      .send(
        page(
          'Confirm your subscription',
          '<p>Confirm that you want email from ' +
            escape(form.brandName ?? 'this brand') +
            '.</p><form method="post"><input type="hidden" name="token" value="' +
            escape(token) +
            '"><button type="submit">Confirm subscription</button></form>',
        ),
      );
  });
  router.get('/:form/unsubscribe', async (req, res) => {
    const token = typeof req.query.t === 'string' && req.query.t.length === 80 ? req.query.t : '';
    res
      .type('html')
      .send(
        page(
          'Unsubscribe',
          '<form method="post"><input type="hidden" name="token" value="' +
            escape(token) +
            '"><button type="submit">Unsubscribe</button></form>',
        ),
      );
  });
  router.post('/:form/unsubscribe', async (req, res) => {
    await service.unsubscribeConfirmation(
      String(req.params.form),
      typeof req.body?.token === 'string' ? req.body.token : '',
    );
    res
      .type('html')
      .send(
        page('Request received', '<p>Marketing for this brand is stopped for an eligible subscription.</p>'),
      );
  });
  router.post('/:form/confirm', async (req, res) => {
    await service.confirm(String(req.params.form), typeof req.body?.token === 'string' ? req.body.token : '');
    res
      .type('html')
      .send(
        page(
          'Subscription confirmed',
          '<p>Your newsletter subscription is confirmed. You can unsubscribe from any newsletter.</p>',
        ),
      );
  });
  router.get('/:form', async (req, res) => {
    const form = await service.publicForm(String(req.params.form));
    const label = form.brandName ?? 'this brand';
    res
      .type('html')
      .send(
        page(
          'News from ' + label,
          (form.mode === 'exercise'
            ? '<p>Staging exercise. Messages are captured for the workspace owner.</p>'
            : '') +
            '<form method="post"><label>Email address <input required type="email" autocomplete="email" name="email" maxlength="254"></label>' +
            '<input type="hidden" name="policyVersion" value="' +
            escape(form.policyVersion) +
            '">' +
            '<label><input required type="checkbox" name="consentAffirmed" value="yes"> ' +
            escape(form.consentText) +
            '</label>' +
            '<button type="submit">Subscribe</button></form><p>' +
            (form.confirmationMode === 'single_opt_in' ? 'No email confirmation is required. You can unsubscribe from any newsletter.' : 'Email confirmation is required.') + ' Tracking is off.</p>',
        ),
      );
  });
  router.post('/:form', async (req, res) => {
    const receipt = await service.publicSignup(String(req.params.form), {
      email: req.body?.email,
      consentAffirmed: req.body?.consentAffirmed === 'yes',
      policyVersion: req.body?.policyVersion,
    });
    res
      .type('html')
      .send(
        page(
          receipt.status === 'request_received' ? 'Request received' : 'Check your email',
          '<p>' + escape(receipt.message) + '</p>',
        ),
      );
  });
  return router;
}
