import type { Express } from 'express';
import express from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { requireCondition } from './errors.js';
import { verifyStagingGifts } from './gifting-evidence.js';
import { recipientGift, rewardLink, viewReward } from './gifting.js';
import {
  availableGiftProviders,
  giftBindings,
  GiftProviderError,
  stagingGiftProviders,
} from './gifting-providers.js';
import { sandboxRun, type SandboxResult } from './gifting-sandbox.js';
import { giftPracticeEnabled, sandboxGiftWorkspace } from '../shared/gifting.js';

const recipient = z
  .object({
    workspace: z.string().min(1).max(160),
    person: z.number().int().min(1).max(100),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export function giftingRoutes(app: Express, config: Config, db?: Database) {
  if (!giftPracticeEnabled(config.environment) || !db) return;
  let sandbox: ReturnType<typeof sandboxRun> | undefined;
  if (config.environment === 'staging') {
    const { missing } = giftBindings(process.env);
    let providerAccess: { stripe: string; tremendous: string } | undefined;
    if (process.env.APP_ENV === 'staging' && missing.length)
      void availableGiftProviders(process.env).then((access) => {
        providerAccess = access;
      });
    let phase = 'Awaiting configuration',
      outcome = 'awaiting_configuration',
      problem: string | undefined,
      result: SandboxResult | undefined;
    if (!missing.length && process.env.APP_ENV === 'staging') {
      sandbox = sandboxRun(db, stagingGiftProviders(process.env));
      const run = sandbox;
      const verify = async (attempt: number) => {
        try {
          phase = 'Checking providers';
          outcome = 'running';
          result = await run.verify((step) => {
            phase = step;
          });
          outcome = 'passed';
          phase = 'Refund verified';
          problem = undefined;
        } catch (error) {
          // SDK errors and raw provider responses can contain credentials, PII or reward links.
          problem =
            error instanceof GiftProviderError ? error.message : 'provider_verification_incomplete';
          outcome = 'incomplete';
          if (attempt < 3) setTimeout(() => void verify(attempt + 1), 30000 * attempt).unref();
        }
      };
      void verify(1);
    }
    app.get('/api/staging/gifting/providers', (_req, res) =>
      res
        .set('Cache-Control', 'no-store')
        .status(outcome === 'passed' ? 200 : 503)
        .json({
          environment: 'staging',
          providers: ['stripe_test', 'tremendous_sandbox'],
          buildSha: config.buildSha,
          unit: 'USD cents',
          state: outcome,
          phase,
          missing,
          providerAccess,
          problem,
          result,
        }),
    );
    let evidence: Awaited<ReturnType<typeof verifyStagingGifts>> | undefined;
    let state = 'running';
    void verifyStagingGifts(db).then(
      (result) => {
        evidence = result;
        state = 'passed';
      },
      () => {
        state = 'failed';
        console.error('Staging gift capture verification failed.');
      },
    );
    app.get('/api/staging/gifting/evidence', (_req, res) =>
      res
        .set('Cache-Control', 'no-store')
        .status(state === 'passed' ? 200 : 503)
        .json({
          environment: 'staging',
          provider: 'simulated',
          buildSha: config.buildSha,
          unit: 'USD cents',
          state,
          result: evidence,
        }),
    );
  }
  app.get('/gifts/claim', (_req, res) =>
    res
      .set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin' })
      .type('html')
      .send(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Your thank-you gift · Flockletter</title><link rel="stylesheet" href="/subscriber-action.css"><main><h1>Your thank-you gift</h1><p>Thank you for being part of our community. Please enjoy this simulated $5 gift.</p><p id="status" role="status">Checking your offer…</p><button hidden id="claim">Claim gift</button><a hidden id="reward">View simulated reward</a></main><script src="/gift-claim.js" defer></script></html>',
      ),
  );
  app.get('/gifts/reward', (_req, res) =>
    res
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Simulated reward · Flockletter</title><link rel="stylesheet" href="/subscriber-action.css"><main><h1>Simulated reward</h1><p id="status" role="status">Checking reward…</p><ul id="products"></ul></main><script src="/gift-claim.js" defer></script></html>',
      ),
  );
  app.post('/api/v1/gifts/reward', express.json({ limit: '1kb' }), async (req, res) => {
    const data = recipient
      .omit({ token: true })
      .extend({
        expires: z.number().int(),
        nonce: z.string().regex(/^[a-f0-9]{24}$/),
        signature: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(req.body);
    res.json(
      await viewReward(db, data.workspace, data.person, data.expires, data.nonce, data.signature),
    );
  });
  for (const action of ['inspect', 'claim'] as const) {
    app.post('/api/v1/gifts/' + action, express.json({ limit: '1kb' }), async (req, res) => {
      if (action === 'claim')
        requireCondition(
          config.browserOrigins.includes(req.get('origin') ?? ''),
          403,
          'origin_rejected',
          'Open the gift page to confirm your claim.',
        );
      const { workspace, person, token } = recipient.parse(req.body);
      if (workspace === sandboxGiftWorkspace)
        requireCondition(
          sandbox,
          503,
          'gift_provider_unavailable',
          'The sandbox provider is unavailable.',
        );
      const offer = await recipientGift(
        db,
        workspace,
        person,
        token,
        action === 'claim',
        sandbox?.submit,
      );
      res.json(
        offer.state === 'claimed'
          ? {
              ...offer,
              reward:
                workspace === sandboxGiftWorkspace && sandbox
                  ? await sandbox.link(person)
                  : await rewardLink(db, workspace, person, token),
            }
          : offer,
      );
    });
  }
}
