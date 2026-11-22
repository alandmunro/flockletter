import { createElement as h } from 'react';
import { ConfirmationFormContent } from '../../shared/ConfirmationFormContent.js';
import { SignupFields } from '../../shared/SignupPostcard.js';
import { sendEmbed, sendPostcard } from './postcard.js';
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
/**
 * FL-BRD-002: a brand's own website (its consent source domain, with or without `www.`) may frame the
 * compact form at `?embed=1`. Every other site, and every other page here, stays `frame-ancestors 'none'`.
 */
export function embedAncestors(sourceDomain: string | undefined) {
  const domain = (sourceDomain ?? '').toLowerCase();
  if (!/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) return [];
  const bare = domain.startsWith('www.') ? domain.slice(4) : domain;
  return ['https://' + bare, 'https://www.' + bare];
}
function allowEmbed(res: Response, sourceDomain: string | undefined) {
  const ancestors = embedAncestors(sourceDomain);
  // Helmet's legacy X-Frame-Options would refuse every framing site; CSP frame-ancestors governs instead.
  res.removeHeader('X-Frame-Options');
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors " +
      (ancestors.length ? ancestors.join(' ') : "'none'") +
      "; base-uri 'none'",
  );
}
const embedRequested = (query: Record<string, unknown>) => query.embed === '1';
/** Optional texting fields from the hosted form. Blank fields are simply absent; none is required. */
function signupTexting(body: Record<string, unknown>) {
  const text = (name: string) => typeof body[name] === 'string' && (body[name] as string).trim() ? (body[name] as string).trim().slice(0, 64) : undefined;
  const int = (name: string, min: number, max: number) => { const v = Number(text(name)); return Number.isInteger(v) && v >= min && v <= max ? v : undefined; };
  const date = (prefix: string, withYear: boolean) => {
    const month = int(prefix + 'Month', 1, 12), day = int(prefix + 'Day', 1, 31), year = withYear ? int(prefix + 'Year', 1900, 2100) : undefined;
    return month && day ? { month, day, ...(year ? { year } : {}) } : undefined;
  };
  return { phone: text('phone'), smsConsent: body.smsConsent === 'yes', wordingShown: typeof body.smsWording === 'string' ? body.smsWording : undefined,
    birthday: date('birthday', false), anniversary: date('anniversary', true) };
}
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
  router.use(async (req, _res, next) => {
    if (req.baseUrl.toLowerCase() === '/signup') {
      const match = /^\/([a-zA-Z0-9-]+)\/?$/.exec(req.path);
      if (!match) throw new AppError(404,'signup_unavailable','Signup page unavailable.');
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      req.url = '/' + await service.resolveSignupSlug(match[1]!) + query;
    }
    next();
  });
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
    const photoUrl = form.design.confirmation?.photoId
      ? '/newsletter/' + encodeURIComponent(String(req.params.form)) + '/confirmation-photo'
      : undefined;
    sendPostcard(res, String(req.params.form), form, form.design.confirmation?.heading || 'Confirm your subscription',
      'You can unsubscribe from any newsletter.', h(ConfirmationFormContent, {design:form.design,brandName:form.brandName,photoUrl,token}));
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
    const form = await service.publicForm(String(req.params.form));
    await service.confirm(String(req.params.form), typeof req.body?.token === 'string' ? req.body.token : '');
    sendPostcard(res, String(req.params.form), form, 'Subscription confirmed', 'You can unsubscribe from any newsletter.',
      h('p', {}, 'Your newsletter subscription is confirmed.'));
  });
  router.get('/:form/confirmation-photo', async (req, res) => {
    const photo = await service.publicConfirmationPhoto(String(req.params.form));
    res.type(photo.mime).send(photo.bytes);
  });
  router.get('/:form/logo', async (req, res) => {
    const logo = await service.publicLogo(String(req.params.form));
    res.type(logo.mime).send(logo.bytes);
  });
  router.get('/:form', async (req, res) => {
    // `?preview=sms` is the view-only form carrier reviewers see before the texting number is active (FL-SMS-007).
    const smsPreview = req.query.preview === 'sms';
    const form = await service.publicForm(String(req.params.form), { smsPreview });
    if (smsPreview && !form.texting?.smsWording) throw new AppError(404, 'preview_unavailable', 'This preview is unavailable.');
    if (!smsPreview && embedRequested(req.query)) {
      allowEmbed(res, form.sourceDomain);
      sendEmbed(res, form, 'ready', [
        form.mode === 'exercise' && h('p', { key: 'mode' }, 'Staging exercise. Messages are captured for the workspace owner.'),
        h(SignupFields, { key: 'signup', consent: form.consentText, version: form.policyVersion, ...(form.texting ? { texting: form.texting } : {}) }),
        h('p', { key: 'foot', className: 'embed-foot' },
          (form.confirmationMode === 'single_opt_in' ? 'No email confirmation is required.' : 'We will email you a link to confirm.') + ' Tracking is off.'),
      ]);
      return;
    }
    sendPostcard(res, String(req.params.form), form, form.design.heading || 'News from '+form.brandName,
      (form.confirmationMode === 'single_opt_in' ? 'No email confirmation is required. You can unsubscribe from any newsletter.' : 'Email confirmation is required.')+' Tracking is off.',
      [form.mode === 'exercise' && h('p',{key:'mode'},'Staging exercise. Messages are captured for the workspace owner.'),
       smsPreview && h('p',{key:'preview'},'Preview of this sign-up form with its optional text message opt-in. Submitting is turned off on this preview.'),
       form.design.introduction && h('p',{key:'intro'},form.design.introduction),
       h(SignupFields,{key:'signup',consent:form.consentText,version:form.policyVersion,preview:smsPreview,...(form.texting?{texting:form.texting}:{})})]);
  });
  router.post('/:form', async (req, res) => {
    const form = await service.publicForm(String(req.params.form));
    const embed = embedRequested(req.query);
    const submit = () => service.publicSignup(String(req.params.form), {
      email: req.body?.email,
      consentAffirmed: req.body?.consentAffirmed === 'yes',
      policyVersion: req.body?.policyVersion,
      ...(embed ? { channel: 'embed' } : {}),
      ...(form.texting ? { texting: signupTexting(req.body ?? {}) } : {}),
    });
    if (embed) {
      allowEmbed(res, form.sourceDomain);
      try {
        const receipt = await submit();
        sendEmbed(res, form, 'submitted', [
          h('h2', { key: 'title' }, receipt.status === 'request_received' ? 'Request received' : 'Check your email'),
          h('p', { key: 'message' }, receipt.message),
        ]);
      } catch (error) {
        // A framed page cannot show the JSON error page, so ordinary refusals are explained in place.
        if (!(error instanceof AppError) || error.status >= 500) throw error;
        res.status(error.status);
        sendEmbed(res, form, 'error', [
          h('p', { key: 'error', role: 'alert', className: 'embed-error' }, error.message),
          h(SignupFields, { key: 'signup', consent: form.consentText, version: form.policyVersion, ...(form.texting ? { texting: form.texting } : {}) }),
        ]);
      }
      return;
    }
    const receipt = await submit();
    sendPostcard(res, String(req.params.form), form, receipt.status === 'request_received' ? 'Request received' : 'Check your email',
      'You can unsubscribe from any newsletter.', h('p', {}, receipt.message));
  });
  return router;
}
