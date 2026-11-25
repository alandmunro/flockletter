import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { CustomerAudience } from '../src/server/customer-audience/service.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { audit } from '../src/server/texting/storage.js';
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
