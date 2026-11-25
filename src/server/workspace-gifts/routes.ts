import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { type Express } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { CustomerWorkflows } from '../customer-runtime.js';
import { requireCondition } from '../errors.js';
import { WorkspaceGiftProvider } from './provider.js';
import {installCheckoutProof} from './checkout-proof.js';
import { verifyWorkspaceGiftEvidence } from './evidence.js';

const callbackKey = z.string().regex(/^[a-zA-Z0-9_:-]{1,160}$/);
const recipient = z
  .object({ workspace: callbackKey, offer: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const binding = z.object({
  workspace: callbackKey,
  brand: z.uuid(),
  lot: z.uuid(),
  purpose: z.literal('flockletter_workspace_gift_v1'),
});
export function verifyTremendousEvent(body: Buffer, header: string, secret: string) {
  requireCondition(
    secret.length >= 16,
    503,
    'gift_webhook_unconfigured',
    'Gift event verification is unavailable.',
  );
  const expected = createHmac('sha256', secret).update(body).digest();
  requireCondition(
    /^sha256=[0-9a-f]{64}$/.test(header) && timingSafeEqual(Buffer.from(header.slice(7), 'hex'), expected),
    403,
    'signature_rejected',
    'Invalid gift event signature.',
  );
  return z
    .object({
      uuid: z.uuid(),
      event: z.string().regex(/^[A-Z_.]{1,80}$/),
      payload: z.object({ resource: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }) }),
    })
    .parse(JSON.parse(body.toString('utf8')));
}
export function workspaceGiftRoutes(app: Express, config: Config, customer?: CustomerWorkflows) {
  if (!customer) return;
  installCheckoutProof(app, customer, config);
  if (config.environment === 'staging' && customer.env.APP_ENV === 'staging') {
    let result: Awaited<ReturnType<typeof verifyWorkspaceGiftEvidence>> | undefined,
      state = 'running';
    void verifyWorkspaceGiftEvidence(customer.db).then(
      (value) => {
        result = value;
        state = 'passed';
      },
      () => {
        state = 'failed';
      },
    );
    app.get('/api/staging/gifting/workspaces', (_req, res) =>
      res
        .set('Cache-Control', 'no-store')
        .status(result ? 200 : 503)
        .json({ environment: 'staging', buildSha: config.buildSha, state, result }),
    );
  }
  const gifts = customer.gifts;
  if (!gifts) return;
  for (const action of ['inspect', 'claim'] as const)
    app.post('/api/v1/workspace-gifts/' + action, express.json({ limit: '2kb' }), async (req, res) => {
      const { workspace, offer, token } = recipient.parse(req.body);
      if (action === 'claim')
        requireCondition(
          config.browserOrigins.includes(req.get('origin') ?? ''),
          403,
          'origin_rejected',
          'Open the gift in a browser to claim.',
        );
      const result = await gifts.recipient(workspace, offer, token, action === 'claim');
      if (result.state === 'pending') await customer.wake(workspace);
      res.set('Referrer-Policy', 'no-referrer').json(result);
    });
  const gateway = gifts.provider;
  if (!(gateway instanceof WorkspaceGiftProvider)) return;
  const raw = express.raw({ type: 'application/json', limit: '128kb' });
  app.post('/api/v1/workspace-gifts/stripe-events', raw, async (req, res) => {
    requireCondition(Buffer.isBuffer(req.body), 415, 'json_required', 'A signed provider event is required.');
    const e = gateway.signedEvent(
      req.body,
      req.get('stripe-signature') ?? '',
      customer.env.FLOCKLETTER_GIFT_STRIPE_WEBHOOK_SECRET ?? '',
    );
    if (
      e.type === 'checkout.session.completed' ||
      e.type === 'checkout.session.async_payment_succeeded' ||
      e.type === 'checkout.session.expired'
    ) {
      const d = binding.safeParse(e.data.object.metadata).data;
      if (d && !(await gifts.processed(d.workspace, e.id))) {
        await gifts.checkoutEvent(d.workspace, d.brand, d.lot, e.data.object.id);
        await customer.wake(d.workspace);
        await gifts.markProcessed(d.workspace, e.id);
      }
    } else if(e.type==='payment_intent.payment_failed'||e.type==='checkout.session.async_payment_failed'){
      const d=binding.safeParse(e.data.object.metadata).data;
      if(d&&!await gifts.processed(d.workspace,e.id)){
        await gifts.paymentFailure(d.workspace,d.brand,d.lot,e.id);
        await customer.wake(d.workspace);await gifts.markProcessed(d.workspace,e.id);
      }
    } else if (
      e.type === 'charge.dispute.created' ||
      e.type === 'charge.dispute.updated' ||
      e.type === 'charge.dispute.closed'
    ) {
      const d = await gateway.dispute(e.data.object.id);
      if (d && !(await gifts.processed(d.workspace, e.id))) {
        await gifts.dispute(d);
        if (d.state === 'needs_response')
          await gateway.submitEvidence(d.id, await gifts.disputeEvidence(d.workspace, d.lot, d.id));
        await customer.wake(d.workspace);
        await gifts.markProcessed(d.workspace, e.id);
      }
    }
    res.sendStatus(200);
  });
  app.post('/api/v1/workspace-gifts/tremendous-events', raw, async (req, res) => {
    requireCondition(Buffer.isBuffer(req.body), 415, 'json_required', 'A signed provider event is required.');
    const event = verifyTremendousEvent(
      req.body,
      req.get('tremendous-webhook-signature') ?? '',
      customer.env.FLOCKLETTER_GIFT_TREMENDOUS_WEBHOOK_SECRET ?? '',
    );
    if (/^(ORDERS|REWARDS|TOPUPS|FUNDING_SOURCES|FRAUD_REVIEWS)\./.test(event.event)) {
      // Provider-wide inbox contains only the event and resource IDs. Workspace workers
      // independently retrieve their own orders before applying any financial change.
      await customer.db.tenant('system:workspace-gifts:provider-events', (sql) =>
        sql.query(
          "INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES(current_setting('app.workspace_id'),$1,$2,$2,$3) ON CONFLICT DO NOTHING",
          [
            'workspace-gifts:vendor-event',
            event.uuid,
            JSON.stringify({ kind: event.event, resource: event.payload.resource.id }),
          ],
        ),
      );
    }
    res.sendStatus(200);
  });
}
