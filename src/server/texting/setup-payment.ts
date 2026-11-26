import Stripe from 'stripe';
import { z } from 'zod';
import { setupFeeFor, textPlanId, type TextPlan } from '../../shared/texting-commercial.js';
import { AppError, requireCondition } from '../errors.js';

export const textingSetupFee = setupFeeFor();
const purpose = 'flockletter_texting_setup';
const metadata = z.object({
  purpose: z.literal(purpose),
  plan: textPlanId.optional(),
  attempt: z.string().regex(/^[1-9]\d{0,9}$/).optional(),
  workspace: z.string().regex(/^org_[A-Za-z0-9_-]{1,120}$/),
  registration: z.uuid(),
  revision: z.string().regex(/^[1-9]\d{0,9}$/),
});
export type SetupTarget = { workspace: string; registration: string; revision: number; plan?: TextPlan; attempt?: number };
export type SetupPayer = { name: string | null; street: string | null; region: string | null; postalCode: string | null; country: string | null };
export type SetupReceipt = { paidAt?:string; target: SetupTarget; outcome: 'paid' | 'declined'; amount: number; eventId: string; sessionId: string; payer: SetupPayer };

export class StripeTestSetupPayment {
  private readonly stripe: Stripe;
  constructor(key: string, private readonly signingSecret: string, private readonly account: string, private readonly origin: string) {
    if (!/^sk_test_/.test(key) || !/^whsec_/.test(signingSecret) || !/^acct_[A-Za-z0-9]+$/.test(account))
      throw Error('Texting setup checkout needs an isolated Stripe test key, account and webhook secret.');
    this.stripe = new Stripe(key, { timeout: 8000, maxNetworkRetries: 0 });
  }

  async open(target: SetupTarget, email: string, key: string, existingSession?: string): Promise<{ id: string; url: string | null; expired?: boolean }> {
    const fee = setupFeeFor(target.plan);
    const account = await this.stripe.accounts.retrieveCurrent();
    requireCondition(account.id === this.account, 503, 'checkout_unavailable', 'The Stripe test checkout account did not match.');
    const session = existingSession ? await this.stripe.checkout.sessions.retrieve(existingSession) : await this.stripe.checkout.sessions.create({
      mode: 'payment', allowed_payment_method_types: ['card'], billing_address_collection: 'required', customer_email: email,
      managed_payments: { enabled: false }, wallet_options: { link: { display: 'never' } },
      name_collection: { business: { enabled: true, optional: false } },
      client_reference_id: target.registration,
      metadata: { workspace: target.workspace, registration: target.registration, revision: String(target.revision), purpose, ...(target.attempt && { attempt: String(target.attempt) }), ...(target.plan ? { plan: target.plan } : {}) },
      line_items: [{ quantity: 1, price_data: {
        currency: fee.currency.toLowerCase(), unit_amount: fee.amount,
        product_data: { name: 'Flockletter texting setup' },
      } }],
      success_url: this.origin + '/', cancel_url: this.origin + '/',
    }, { idempotencyKey: key });
    const bind = metadata.safeParse(session.metadata);
    requireCondition(!session.livemode && bind.success && (!existingSession || session.id === existingSession) &&
      bind.data.workspace === target.workspace && bind.data.registration === target.registration && bind.data.revision === String(target.revision) &&
      bind.data.plan === target.plan && Number(bind.data.attempt ?? 1) === (target.attempt ?? 1) && session.client_reference_id === target.registration &&
      session.mode === 'payment' && session.amount_total === fee.amount && session.currency === 'usd',
    409, 'checkout_mismatch', 'The Stripe test checkout did not match this enrollment and price.');
    if (session.status === 'expired' && session.payment_status === 'unpaid') return { id: session.id, url: null, expired: true };
    const url = session.url ? z.url({ protocol: /^https$/, hostname: /^checkout\.stripe\.com$/ }).parse(session.url) : null;
    return { id: session.id, url };
  }

  receipt(raw: Buffer, signature: string): SetupReceipt | null {
    let event: Stripe.Event;
    try { event = this.stripe.webhooks.constructEvent(raw, signature, this.signingSecret); }
    catch { throw new AppError(403, 'signature_rejected', 'The Stripe setup payment event signature is invalid.'); }
    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded' &&
      event.type !== 'checkout.session.expired' && event.type !== 'checkout.session.async_payment_failed') return null;
    const session = event.data.object;
    if (session.metadata?.purpose !== purpose) return null;
    const bind = metadata.safeParse(session.metadata);
    requireCondition(bind.success && event.livemode === false && session.livemode === false &&
      (!event.account || event.account === this.account) && session.mode === 'payment' &&
      session.client_reference_id === bind.data.registration && session.amount_total === setupFeeFor(bind.data.plan).amount &&
      session.currency === textingSetupFee.currency.toLowerCase(), 409, 'checkout_mismatch', 'The Stripe test receipt did not match the setup enrollment.');
    const declined = session.payment_status === 'unpaid' && ((event.type === 'checkout.session.expired' && session.status === 'expired') ||
      event.type === 'checkout.session.async_payment_failed');
    if (!declined && (session.payment_status !== 'paid' || event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed')) return null;
    const details = session.customer_details, address = details?.address;
    return {
      target: { workspace: bind.data.workspace, registration: bind.data.registration, revision: Number(bind.data.revision), ...(bind.data.plan ? { plan: bind.data.plan } : {}), ...(bind.data.attempt && { attempt: Number(bind.data.attempt) }) },
      outcome: declined ? 'declined' : 'paid', amount: session.amount_total,
      paidAt:new Date(event.created*1000).toISOString(), eventId: event.id, sessionId: session.id,
      payer: { name: details?.business_name ?? details?.name ?? null, street: address?.line1 ?? null,
        region: address?.state ?? null, postalCode: address?.postal_code ?? null, country: address?.country ?? null },
    };
  }
}
