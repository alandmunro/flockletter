import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { CustomerAudience } from '../src/server/customer-audience/service.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { audit } from '../src/server/texting/storage.js';
import { Texting } from '../src/server/texting/service.js';
import type { OnboardingView } from '../src/shared/texting-onboarding.js';
import { makeHostedPolicySnapshot } from '../src/shared/texting-policy-pages.js';

const origin = 'https://staging.example';
let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, audience: CustomerAudience;
type Publication = { workspace: string; brand: string; slug: string };
const publications: Publication[] = [];

beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  const checkOwner = async () => true;
  const core = new CommandService(db, undefined, checkOwner);
  audience = new CustomerAudience(db, { mode: 'exercise', origin, checkOwner, contactLimit: async () => 250 });
  for (const label of ['Pine', 'Elm']) {
    const workspace = 'org_policy_' + label;
    const actor: Actor = { actorId: 'user:' + label, userId: label, kind: 'session', workspaceId: workspace, owner: true, scopes: ['read'], brandIds: null };
    await core.execute('workspace.initialize', { operationKey: randomUUID(), name: label, brandName: label }, actor);
    const { brand, company } = await db.read(workspace, async sql => (await sql.query<{ brand: string; company: string }>(
      'SELECT brand_id brand, company_id company FROM company_brands')).rows[0]!);
    await audience.execute('audienceOnboarding.configure', { operationKey: randomUUID(), brandId: brand, enabled: true, purpose: 'news',
      policyVersion: 'v1', consentText: 'Email me news and business updates. I can unsubscribe at any time.', sourceDomain: 'brand.example' }, actor);
    await db.brand(workspace, brand, async sql => {
      const shortName = 'practice-' + label.toLowerCase();
      await sql.query('SELECT flockletter_customer_jobs.texting_claim_short_name($1,$2,30)', [workspace, shortName]);
      await sql.query(`INSERT INTO sms_workspace_profile(workspace_id,short_name) VALUES($1,$2)
        ON CONFLICT(workspace_id) DO UPDATE SET short_name=EXCLUDED.short_name`, [workspace, shortName]);
      const slug = (await sql.query<{ slug: string }>('SELECT public.flockletter_signup_slug(form_token) slug FROM customer_audience_settings')).rows[0]!.slug;
      const id = randomUUID();
      const details = { legalName: label, publicContact: 'public@brand.example', description: 'Seasonal updates.',
        signupUrl: origin + '/signup/' + slug, acceptedAt: '2026-11-25T10:00:00Z' };
      const older = makeHostedPolicySnapshot({ ...details, description: 'First publication for ' + label, revision: 1 });
      const current = makeHostedPolicySnapshot({ ...details, revision: 2 });
      await sql.query(`INSERT INTO sms_carrier_brands(workspace_id,id,company_id,legal_name,entity_type,profile,help_contact,created_by,
        privacy_policy_confirmed_at,sms_terms_confirmed_at) VALUES ($1,$2,$3,$4,'private_profit',$5,'help@brand.example',$6,now(),now())`,
        [workspace, id, company, label, JSON.stringify({ hostedPolicy: current, contact: { email: 'private@brand.example' } }), actor.actorId]);
      await audit(sql, workspace, actor.actorId, 'ui', 'onboarding.policy_published', id, null, older);
      publications.push({ workspace, brand, slug });
    });
  }
});

afterAll(async () => { await db?.close(); await fixture?.stop(); });

it('returns only the accepted company snapshot for the enabled public signup route and requested version', async () => {
  const [pine, elm] = publications;
  const current = await audience.publicTextingPolicy(pine!.slug);
  expect(current.legalName).toBe('Pine');
  expect(current.revision).toBe(2);
  expect(JSON.stringify(current)).not.toContain('private@brand.example');
  expect((await audience.publicTextingPolicy(elm!.slug, 1)).description).toBe('First publication for Elm');
  expect((await audience.publicTextingPolicy(pine!.slug, 1)).description).toBe('First publication for Pine');
  expect((await audience.publicTextingPolicy(pine!.slug, undefined, 'practice-pine')).legalName).toBe('Pine');
  await expect(audience.publicTextingPolicy(pine!.slug, undefined, 'practice-elm')).rejects.toMatchObject({ status: 404 });
  await expect(audience.publicTextingPolicy(pine!.slug, 3)).rejects.toMatchObject({ status: 404 });
  await db.brand(pine!.workspace, pine!.brand, sql => sql.query('UPDATE customer_audience_settings SET enabled=false'));
  await expect(audience.publicTextingPolicy(pine!.slug, 1)).rejects.toMatchObject({ status: 404 });
  expect((await audience.publicTextingPolicy(elm!.slug)).legalName).toBe('Elm');
});

it('discards a late website check after the owner edits the enrollment or disables the signup page', async () => {
  const workspace = 'org_scan_race';
  const actor: Actor = { workspaceId: workspace, userId: 'Cedar', actorId: 'user:Cedar', kind: 'session', owner: true, scopes: ['read'], brandIds: null };
  const business = {
    legalName: 'Cedar Practice LLC', ein: '00-0072322', businessType: 'Limited Liability Corporation', vertical: 'RETAIL',
    website: 'https://cedar.example.test', privacyPolicyUrl: 'https://cedar.example.test/old-privacy', smsTermsUrl: 'https://cedar.example.test/terms',
    street: '1 Example Street', city: 'New York', region: 'NY', postalCode: '10001',
    firstName: 'Sample', lastName: 'Owner', title: 'Owner', email: 'owner@cedar.example.test', phone: '+12125550120',
  };
  const correctedPrivacy = business.website + '/new-privacy';
  let holdPage = business.privacyPolicyUrl;
  function pauseReader() {
    let began!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    return { started, began, release, waiting };
  }
  let barrier = pauseReader();
  const readEnrollmentPage = async (url: string) => {
    if (url === holdPage) { barrier.began(); await barrier.waiting; }
    if (url === business.privacyPolicyUrl) return '<p>Policy under construction.</p>';
    return '<p>Business news. We do not share mobile opt-in data for marketing. Frequency varies. Msg and data rates may apply. Reply STOP or HELP.</p>' +
      '<input type="checkbox" name="smsConsent"><a href="' + correctedPrivacy + '">Privacy</a><a href="' + business.smsTermsUrl + '">Terms</a>';
  };
  let clock = Date.now();
  const checkOwner = async () => true;
  const core = new CommandService(db, undefined, checkOwner);
  const texting = Texting.mock(db, { origin, linkOrigin: origin + '/l', isOwner: checkOwner, onboardingCapture: true, readEnrollmentPage, now: () => new Date(clock) });
  await core.execute('workspace.initialize', { operationKey: randomUUID(), name: 'Cedar', brandName: 'Cedar' }, actor);
  const { brand, company } = await db.read(workspace, async sql => (await sql.query<{ brand: string; company: string }>(
    'SELECT brand_id brand, company_id company FROM company_brands')).rows[0]!);
  const access = new CustomerAudience(db, { mode: 'exercise', origin, checkOwner, contactLimit: async () => 250, texting });
  const settings = { brandId: brand, purpose: 'news', policyVersion: 'v1', consentText: 'Send me news. I can unsubscribe at any time.', sourceDomain: 'cedar.example.test' };
  const config = (enabled: boolean) => access.execute('audienceOnboarding.configure', { ...settings, enabled, operationKey: randomUUID() }, actor);
  const save = (expectedRevision: number | null, privacyPolicyUrl: string) => texting.execute('sms.onboardingSave',
    { companyId: company, operationKey: randomUUID(), business: { ...business, privacyPolicyUrl }, expectedRevision, accepted: true }, actor, 'ui');
  const check = () => texting.execute('sms.onboardingScan', { companyId: company, operationKey: randomUUID(), expectedRevision: 2 }, actor, 'ui');
  const status = () => texting.execute('sms.onboardingStatus', { companyId: company }, actor, 'ui') as Promise<OnboardingView>;
  await texting.execute('sms.configure', { operationKey: randomUUID(), expectedRevision: 1, phoneField: true }, actor, 'ui');
  await config(true);

  const oldScan = save(null, business.privacyPolicyUrl);
  await Promise.race([barrier.started, oldScan.then(() => { throw new Error('Expected the first scan to wait for its privacy page.'); })]);
  try {
    await save(1, correctedPrivacy);
    expect(await status()).toMatchObject({ revision: 2, pageCheck: { issues: [] } });
  } finally { barrier.release(); await oldScan; }
  expect(await status()).toMatchObject({ revision: 2, business: { privacyPolicyUrl: correctedPrivacy }, pageCheck: { issues: [] } });

  clock += 6000;
  holdPage = correctedPrivacy;
  barrier = pauseReader();
  const lateCheck = check();
  await Promise.race([barrier.started, lateCheck.then(() => { throw new Error('Expected the new scan to wait for its privacy page.'); })]);
  try { await config(false); } finally { barrier.release(); }
  await expect(lateCheck).resolves.toEqual({ checked: false });
  expect((await status()).pageCheck).toBeNull();
  await expect(check()).resolves.toMatchObject({ checked: true, issues: [{ page: 'signup' }] });
});
