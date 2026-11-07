import express, { type Express, type Request, type Response as HttpResponse } from 'express';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import {
  loadMarketingLinks,
  marketingUnsubscribePath,
  redeemMarketingLink,
  type MarketingLinks,
} from './marketing-links.js';

const pair = ['List-Unsubscribe', 'One-Click'] as const;
const formMarkup = `<main>
  <h1>Unsubscribe</h1>
  <p>Choose Unsubscribe to stop marketing messages from this brand.</p>
  <form method="post">
    <button type="submit" name="List-Unsubscribe" value="One-Click">Unsubscribe</button>
  </form>
</main>`;
const receiptMarkup =
  '<main><h1>Unsubscribe request received</h1><p>If this link matches a subscription, marketing email from this brand is stopped.</p></main>';
function page(main: string) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Unsubscribe | Flockletter</title><link rel="stylesheet" href="/subscriber-action.css"></head><body><header>Flockletter<img src="/brand/frosty-flamingo-software.png" alt="Frosty Flamingo Software"></header>' +
    main +
    '</body></html>'
  );
}
function protect(response: HttpResponse) {
  response.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  });
}
function refuseForeignBrowser(req: Request, origin: string) {
  const source = req.get('origin');
  const site = req.get('sec-fetch-site');
  if (
    (source !== undefined && source !== origin) ||
    (site !== undefined && site !== 'same-origin') ||
    (source === undefined &&
      (site ||
        req.get('sec-fetch-mode') ||
        req.get('sec-fetch-dest') ||
        req.get('sec-fetch-user') ||
        req.get('authorization') !== undefined ||
        req.get('cookie') !== undefined))
  ) {
    throw new AppError(403, 'origin_rejected', 'Use the original unsubscribe link.');
  }
}
async function validBody(req: Request) {
  if (!Buffer.isBuffer(req.body)) return false;
  let entries: [string, unknown][];
  try {
    if (req.is('application/x-www-form-urlencoded')) {
      entries = [...new URLSearchParams(req.body.toString('utf8'))];
    } else {
      // Parsing occurs only after express.raw enforces the 4 KiB limit and rejects compressed bodies.
      const response = new Response(new Uint8Array(req.body), {
        headers: { 'Content-Type': req.get('content-type')! },
      });
      entries = [...(await response.formData()).entries()];
    }
  } catch {
    return false;
  }
  return entries.length === 1 && entries[0]![0] === pair[0] && entries[0]![1] === pair[1];
}

export function marketingUnsubscribeRoutes(
  app: Express,
  config: Config,
  db?: Database,
  settings: MarketingLinks | undefined = loadMarketingLinks(config.origin),
) {
  app.all(marketingUnsubscribePath, (req, res, next) => {
    protect(res);
    if (
      settings &&
      (req.get('host')?.toLowerCase() !== new URL(settings.origin).host ||
        (config.environment === 'staging' && !req.secure))
    ) {
      throw new AppError(403, 'origin_rejected', 'Use the original unsubscribe link.');
    }
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
      res.set('Allow', 'GET, HEAD, POST').status(405).end();
      return;
    }
    next();
  });
  // Mail scanners may fetch the URL. GET and HEAD never check a subscriber or change state.
  app.get(marketingUnsubscribePath, (_req, res) => res.type('html').send(page(formMarkup)));
  app.post(
    marketingUnsubscribePath,
    (req, _res, next) => {
      refuseForeignBrowser(req, config.origin);
      if (!req.is(['application/x-www-form-urlencoded', 'multipart/form-data'])) {
        throw new AppError(415, 'form_required', 'Send an unsubscribe form.');
      }
      next();
    },
    (req, res, next) =>
      express.raw({ type: () => true, limit: 4096, inflate: false })(req, res, (error) => {
        if (!error) return next();
        const status = error.status === 413 ? 413 : error.status === 415 ? 415 : 400;
        next(new AppError(status, 'invalid_form', 'Use a small uncompressed unsubscribe form.'));
      }),
    async (req, res) => {
      if (!(await validBody(req))) throw new AppError(400, 'invalid_form', 'Use the unsubscribe form.');
      if (!settings || !db)
        throw new AppError(
          503,
          'unsubscribe_unavailable',
          'Unsubscribe is temporarily unavailable. Try again.',
        );
      const token = req.query.t;
      if (typeof token === 'string' && token.length <= 128) await redeemMarketingLink(db, settings, token);
      // Unknown links, complete replays, and valid new opt-outs share a response.
      if (req.get('origin')) res.type('html').send(page(receiptMarkup));
      else res.status(204).end();
    },
  );
}
