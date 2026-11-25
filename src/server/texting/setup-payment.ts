import Stripe from 'stripe';
import { z } from 'zod';
import { AppError, requireCondition } from '../errors.js';

export const textingSetupFee = { amount: 4900, currency: 'USD' } as const;
const purpose = 'flockletter_texting_setup';
const metadata = z.object({
  purpose: z.literal(purpose),
  workspace: z.string().regex(/^org_[A-Za-z0-9_-]{1,120}$/),
  registration: z.uuid(),
  revision: z.string().regex(/^[1-9]\d{0,9}$/),
});
export type SetupTarget = { workspace: string; registration: string; revision: number };
export type SetupPayer = { name: string | null; street: string | null; region: string | null; postalCode: string | null; country: string | null };
export type SetupReceipt = { target: SetupTarget; eventId: string; sessionId: string; payer: SetupPayer };

export class StripeTestSetupPayment {
  private readonly stripe: Stripe;
  constructor(key: string, private readonly signingSecret: string, private readonly account: string, private readonly origin: string) {
    if (!/^sk_test_/.test(key) || !/^whsec_/.test(signingSecret) || !/^acct_[A-Za-z0-9]+$/.test(account))
      throw Error('Texting setup checkout needs an isolated Stripe test key, account and webhook secret.');
    this.stripe = new Stripe(key, { timeout: 8000, maxNetworkRetries: 0 });
  }

  async open(target: SetupTarget, email: string, key: string) {
    const account = await this.stripe.accounts.retrieveCurrent();
    requireCondition(account.id === this.account, 503, 'checkout_unavailable', 'The Stripe test checkout account did not match.');
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment', allowed_payment_method_types: ['card'], billing_address_collection: 'required', customer_email: email,
      managed_payments: { enabled: false }, wallet_options: { link: { display: 'never' } },
      name_collection: { business: { enabled: true, optional: false } },
      client_reference_id: target.registration,
      metadata: { ...target, revision: String(target.revision), purpose },
      line_items: [{ quantity: 1, price_data: {
        currency: textingSetupFee.currency.toLowerCase(), unit_amount: textingSetupFee.amount,
        product_data: { name: 'Flockletter texting setup' },
      } }],
      success_url: this.origin + '/', cancel_url: this.origin + '/',
    }, { idempotencyKey: key });
    requireCondition(!session.livemode && session.client_reference_id === target.registration, 503, 'checkout_unavailable', 'The Stripe test checkout did not match.');
    requireCondition(session.status !== 'expired', 409, 'checkout_reconciliation_required', 'This Stripe test checkout expired and needs reconciliation.');
    const url = session.url ? z.url({ protocol: /^https$/, hostname: /^checkout\.stripe\.com$/ }).parse(session.url) : null;
    return { id: session.id, url };
  }

  receipt(raw: Buffer, signature: string): SetupReceipt | null {
    let event: Stripe.Event;
    try { event = this.stripe.webhooks.constructEvent(raw, signature, this.signingSecret); }
    catch { throw new AppError(403, 'signature_rejected', 'The Stripe setup payment event signature is invalid.'); }
    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return null;
    const session = event.data.object;
    if (session.metadata?.purpose !== purpose) return null;
    const bind = metadata.safeParse(session.metadata);
    requireCondition(bind.success && event.livemode === false && session.livemode === false &&
      (!event.account || event.account === this.account) && session.mode === 'payment' &&
      session.client_reference_id === bind.data.registration && session.amount_total === textingSetupFee.amount &&
      session.currency === textingSetupFee.currency.toLowerCase(), 409, 'checkout_mismatch', 'The Stripe test receipt did not match the setup enrollment.');
    if (session.payment_status !== 'paid') return null;
    const details = session.customer_details, address = details?.address;
    return {
      target: { workspace: bind.data.workspace, registration: bind.data.registration, revision: Number(bind.data.revision) },
      eventId: event.id, sessionId: session.id,
      payer: { name: details?.business_name ?? details?.name ?? null, street: address?.line1 ?? null,
        region: address?.state ?? null, postalCode: address?.postal_code ?? null, country: address?.country ?? null },
    };
  }
}
