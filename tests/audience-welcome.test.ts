import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { CustomerAudience, redeemCustomerOptOut, type CustomerConfirmationPort } from '../src/server/customer-audience/service.js';
import type { WelcomeEnvelope } from '../src/server/customer-audience/welcome-email.js';
import { renderWelcomeEmail, renderWelcomePreview } from '../src/shared/welcome-email.js';
import { defaultDesign, signupDesign, type WelcomeDesign } from '../src/shared/signup-design.js';
import type { AudienceSettingsView } from '../src/shared/customer-audience.js';

const welcome: WelcomeDesign = {
  enabled: true,
  subject: 'Welcome to Keystone <news>',
  message: 'Thank you for signing up for our newsletter.\nHere’s your promo code:',
  promoCode: 'Dec2026',
  promoDetails: 'Use it when you book direct.',
  link: 'https://stay.example.test/book?a=1&b=2',
  button: 'Book your stay',
};

it('renders the promo code, escaped copy, button and unsubscribe links', () => {
  const mail = renderWelcomeEmail(
    { brandName: 'Keystone & Co', welcome },
    { unsubscribeUrl: 'https://mail.example.test/newsletter/opt-out?t=x', preferencesUrl: 'https://mail.example.test/newsletter/preferences?t=y' },
  );
  expect(mail.subject).toBe('Welcome to Keystone <news>');
  expect(mail.preheader).toBe('Your promo code: Dec2026');
  expect(mail.html).toContain('>Dec2026</div>');
  expect(mail.html).toContain('Keystone &amp; Co');
  expect(mail.html).toContain('Thank you for signing up for our newsletter.<br>Here’s your promo code:');
  expect(mail.html).toContain('href="https://stay.example.test/book?a=1&amp;b=2"');
  expect(mail.html).toContain('Book your stay</a>');
  expect(mail.html).toContain('href="https://mail.example.test/newsletter/opt-out?t=x"');
  expect(mail.html).toContain('Manage preferences');
  expect(mail.text).toContain('Promo code: Dec2026');
  expect(mail.text).toContain('Unsubscribe: https://mail.example.test/newsletter/opt-out?t=x');
  const plain = renderWelcomeEmail({ brandName: 'Keystone', welcome: { enabled: true } }, { unsubscribeUrl: 'https://m.example.test/o' });
  expect(plain.subject).toBe('Welcome to the Keystone newsletter');
  expect(plain.html).not.toContain('PROMO CODE');
  expect(plain.html).not.toMatch(/bgcolor="#83364f"/);
  expect(() => renderWelcomeEmail({ brandName: 'K', welcome }, { unsubscribeUrl: 'http://m.example.test/o' })).toThrow();
});

it('previews with inert links and validates welcome input', () => {
  const preview = renderWelcomePreview({ ...defaultDesign, welcome }, 'Keystone');
  expect(preview.html).toContain('Dec2026');
  expect(preview.html).not.toMatch(/href=|src="cid:|preview\.invalid/);
  for (const bad of [{ link: 'http://stay.example.test' }, { link: 'https://u:p@stay.example.test' }, { promoCode: 'DEC 2026' }, { subject: 'a\nb' }])
    expect(signupDesign.safeParse({ ...defaultDesign, welcome: { ...welcome, ...bad } }).success).toBe(false);
  expect(signupDesign.safeParse({ ...defaultDesign, welcome: { enabled: false, link: '', promoCode: '' } }).success).toBe(true);
});

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});

async function setup(design: WelcomeDesign | undefined, submitWelcome: (m: WelcomeEnvelope) => ReturnType<NonNullable<CustomerConfirmationPort['submitWelcome']>>) {
  const workspace = 'org_' + randomUUID().replaceAll('-', '');
  const owner: Actor = { workspaceId: workspace, userId: 'user_owner', actorId: 'user:owner', owner: true, kind: 'session', scopes: ['read'], brandIds: null };
  const core = new CommandService(db);
  await core.execute('workspace.initialize', { operationKey: randomUUID(), name: 'Owner shop', brandName: 'Keystone' }, owner);
  const brand = ((await core.execute('workspace.get', {}, owner)) as { brands: { id: string }[] }).brands[0]!.id;
  let confirmUrl = '';
  const live = new CustomerAudience(db, {
    mode: 'live',
    origin: 'https://mail.example.test',
    checkOwner: async () => true,
    confirmationKey: Buffer.alloc(32, 9),
    provider: {
      submit: async (message) => { confirmUrl = message.confirmUrl; return { state: 'accepted', providerId: randomUUID() }; },
      lookup: async () => ({ state: 'unknown' }),
      submitWelcome,
    },
  });
  await live.execute('audienceOnboarding.configure', {
    operationKey: randomUUID(), brandId: brand, enabled: true, purpose: 'shop_news', policyVersion: 'v1',
    consentText: 'Send me occasional news. I can unsubscribe anytime.', sourceDomain: 'stay.example.test',
  }, owner);
  const view = (await live.execute('audienceOnboarding.status', { brandId: brand }, owner)) as AudienceSettingsView;
  if (design) await live.execute('audienceOnboarding.saveDesign', {
    operationKey: randomUUID(), brandId: brand, expectedRevision: view.designRevision ?? 0, design: { ...defaultDesign, welcome: design },
  }, owner);
  const form = view.publicUrl!.split('/newsletter/')[1]!;
  const signUpAndConfirm = async (email: string) => {
    await live.publicSignup(form, { email, consentAffirmed: true, policyVersion: 'v1' });
    await live.tick(workspace, brand);
    const token = new URL(confirmUrl).searchParams.get('t')!;
    await live.confirm(form, token);
    return token;
  };
  const welcomes = () => db.brand(workspace, brand, async sql =>
    (await sql.query<{ state: string; attempts: number; error_code: string | null; welcome_snapshot: WelcomeDesign }>(
      'SELECT state,attempts,error_code,welcome_snapshot FROM customer_audience_welcomes ORDER BY created_at')).rows);
  return { workspace, brand, form, live, signUpAndConfirm, welcomes };
}

it('sends one welcome with the promo code after double opt-in, and never resends', async () => {
  const sent: WelcomeEnvelope[] = [];
  const a = await setup(welcome, async (m) => { sent.push(m); return { state: 'accepted', providerId: randomUUID() }; });
  expect(JSON.stringify(await a.live.publicForm(a.form))).not.toContain('Dec2026');
  const token = await a.signUpAndConfirm('guest@realshop.com');
  expect(await a.welcomes()).toMatchObject([{ state: 'queued', attempts: 0 }]);
  await a.live.confirm(a.form, token);
  expect(await a.live.tickWelcome(a.workspace, a.brand)).toEqual({ processed: true });
  expect(await a.live.tickWelcome(a.workspace, a.brand)).toEqual({ processed: false });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ to: 'guest@realshop.com', brandName: 'Keystone', welcome: { promoCode: 'Dec2026' } });
  expect(sent[0]!.unsubscribeUrl).toMatch(/^https:\/\/mail\.example\.test\/newsletter\/opt-out\?t=/);
  expect(await a.welcomes()).toMatchObject([{ state: 'accepted', attempts: 1 }]);
  // The welcome's own link unsubscribes the confirmed subscriber.
  await redeemCustomerOptOut(db, new URL(sent[0]!.unsubscribeUrl).searchParams.get('t')!);
  const state = await db.brand(a.workspace, a.brand, async sql => (await sql.query<{ state: string }>('SELECT state FROM subscribers')).rows[0]!.state);
  expect(state).toBe('unsubscribed');
});

it('queues nothing when the welcome is off', async () => {
  let calls = 0;
  const a = await setup({ ...welcome, enabled: false }, async () => { calls++; return { state: 'accepted' }; });
  await a.signUpAndConfirm('guest@realshop.com');
  expect(await a.welcomes()).toEqual([]);
  expect(await a.live.tickWelcome(a.workspace, a.brand)).toEqual({ processed: false });
  expect(calls).toBe(0);
});

it('keeps an unknown provider outcome uncertain and cancels for unsubscribed or disabled cases', async () => {
  let calls = 0;
  const a = await setup(welcome, async () => { calls++; throw Error('lost provider reply'); });
  await a.signUpAndConfirm('one@realshop.com');
  await a.live.tickWelcome(a.workspace, a.brand);
  expect(await a.live.tickWelcome(a.workspace, a.brand)).toEqual({ processed: false });
  expect(calls).toBe(1);
  expect(await a.welcomes()).toMatchObject([{ state: 'uncertain', error_code: 'reconciliation_required' }]);

  const b = await setup(welcome, async () => { calls++; return { state: 'accepted' }; });
  await b.signUpAndConfirm('two@realshop.com');
  await db.brand(b.workspace, b.brand, sql => sql.query("UPDATE subscribers SET state='unsubscribed'"));
  await b.live.tickWelcome(b.workspace, b.brand);
  expect(await b.welcomes()).toMatchObject([{ state: 'cancelled', error_code: 'recipient_ineligible' }]);
  expect(calls).toBe(1);
});
