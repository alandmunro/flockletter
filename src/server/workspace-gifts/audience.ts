import { twilioIndustries, type TwilioIndustry } from '../../shared/texting-business.js';
import type { RegistrationState } from '../../shared/texting.js';
import { productionConsentEligibleBatch } from '../customer-audience/service.js';
import type { Database, Sql } from '../db.js';
import { lockWorkspace } from '../workspace-lock.js';

export type GiftRecipient = { id: string; label: string; email?: string; phone?: string };

// The caller owns authority and opens db.brand(...) before reading. The explicit context
// check also protects workspace-scoped SMS tables when passed an incorrectly scoped Sql.
const scopedBrand = `SELECT workspace_id,id AS brand_id FROM brands
  WHERE workspace_id=$1 AND id=$2 AND workspace_id=current_setting('app.workspace_id',true)
    AND id::text=current_setting('app.intake_brand_id',true)`;

type Candidate = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  contact_id: string | null;
};

export async function eligibleGiftRecipients(
  sql: Sql,
  workspaceId: string,
  brandId: string,
  consentMode: 'live' | 'exercise' = 'live',
): Promise<GiftRecipient[]> {
  const { rows } = await sql.query<Candidate>(
    `
    WITH scope AS (${scopedBrand}),
    links AS (
      SELECT DISTINCT ON (subscriber_id) subscriber_id, contact_id FROM (
        SELECT l.subscriber_id,l.contact_id,0 AS priority,l.created_at AS at
        FROM sms_contact_subscribers l JOIN scope USING(workspace_id,brand_id)
        UNION ALL
        SELECT c.subscriber_id,c.id,1,c.updated_at
        FROM sms_contacts c JOIN scope USING(workspace_id,brand_id) WHERE c.subscriber_id IS NOT NULL
      ) candidates ORDER BY subscriber_id,priority,at DESC,contact_id
    ), phones AS (
      SELECT c.id,c.brand_id,c.subscriber_id,c.first_name,c.last_name,c.name,
        CASE WHEN c.textable AND x.state='opted_in' THEN c.phone_e164 END AS phone
      FROM scope JOIN company_brands cb USING(workspace_id,brand_id)
      JOIN sms_consents x USING(workspace_id,company_id)
      JOIN sms_contacts c ON (c.workspace_id,c.id)=(x.workspace_id,x.contact_id)
    ), people AS (
      SELECT s.id,s.created_at,l.contact_id,NULLIF(trim(concat_ws(' ',s.first_name,s.last_name)),'') AS name,
        CASE WHEN s.state='confirmed' THEN s.email_normalized END AS email,p.phone
      FROM subscribers s JOIN scope USING(workspace_id,brand_id)
      LEFT JOIN links l ON l.subscriber_id=s.id LEFT JOIN phones p ON p.id=l.contact_id
      UNION ALL
      SELECT p.id,NULL,p.id,coalesce(NULLIF(trim(concat_ws(' ',p.first_name,p.last_name)),''),p.name),NULL,p.phone
      FROM phones p CROSS JOIN scope b
      WHERE p.phone IS NOT NULL AND p.subscriber_id IS NULL AND (p.brand_id=b.brand_id OR p.brand_id IS NULL)
        AND NOT EXISTS (SELECT FROM sms_contact_subscribers l WHERE l.workspace_id=b.workspace_id AND l.contact_id=p.id)
    )
    SELECT id,name,email,phone,contact_id FROM people WHERE email IS NOT NULL OR phone IS NOT NULL
    ORDER BY created_at NULLS LAST,id`,
    [workspaceId, brandId],
  );

  // WA-03 preserves the email local part. Its stored normalized email is unique per brand,
  // and a workspace contact ID uniquely identifies an E.164 number, even after STOP.
  const emailIds = rows.filter((row) => row.email !== null).map((row) => row.id);
  const exercise = consentMode === 'exercise' && process.env.APP_ENV !== 'production';
  const allowedEmail = new Set(
    exercise || !emailIds.length ? emailIds : await productionConsentEligibleBatch(sql, emailIds),
  );
  const groups = new Map<string, GiftRecipient>();
  for (const row of rows) {
    const email = allowedEmail.has(row.id) ? row.email : null;
    if (!email && !row.phone) continue;
    const key = row.contact_id ? 'phone/' + row.contact_id : 'subscriber/' + row.id;
    // Choose one actual WA-03 person, preferring an eligible email then the oldest record.
    // Never attach another household member's address or name to that person's ID.
    const prior = groups.get(key);
    if (prior && (prior.email || !email)) continue;
    groups.set(key, {
      id: row.id,
      label: row.name || email || 'Phone ending ' + row.phone!.slice(-4),
      ...(email ? { email } : {}),
      ...(row.phone ? { phone: row.phone } : {}),
    });
  }
  return [...groups.values()];
}

type ProbationState = 'canary' | 'active' | 'paused' | 'suspended' | 'complete';
export type GiftWorkspaceOnboardingFacts = {
  companyId: string | null;
  registrationState: RegistrationState | null;
  registrationSource: 'sms_registration' | 'wa05_mock_onboarding' | 'staging_fixture' | null;
  industry: TwilioIndustry | null;
  probationState: ProbationState | null;
  probationSource: 'wa05_mock_onboarding' | 'staging_fixture' | null;
  setupPaymentSource: 'capture' | 'stripe_test' | null;
  firstClearedPaymentAt: string | null;
  firstClearedPaymentSource: null;
};

export async function giftWorkspaceOnboardingFacts(
  sql: Sql,
  workspaceId: string,
  brandId: string,
): Promise<GiftWorkspaceOnboardingFacts> {
  const {
    rows: [row],
  } = await sql.query<{
    company_id: string;
    registration_state: RegistrationState | null;
    industry: string | null;
    probation: string | null;
    payment_source: string | null;
    onboarding: boolean;
    fixture: boolean;
  }>(
    `WITH scope AS (${scopedBrand})
    SELECT cb.company_id,r.state AS registration_state,b.profile->>'vertical' AS industry,
      b.profile ? 'onboarding' AS onboarding,b.created_by='fixture:gifting:audience:v1' AS fixture,
      CASE WHEN r.state='approved' THEN b.profile#>>'{onboarding,probation,state}' END AS probation,
      CASE WHEN b.profile#>>'{onboarding,payment,state}'='paid' THEN b.profile#>>'{onboarding,payment,source}' END AS payment_source
    FROM scope JOIN company_brands cb USING(workspace_id,brand_id)
    LEFT JOIN sms_carrier_brands b USING(workspace_id,company_id)
    LEFT JOIN sms_registrations r ON (r.workspace_id,r.carrier_brand_id)=(b.workspace_id,b.id)`,
    [workspaceId, brandId],
  );
  const probation = row?.probation;
  const probationState =
    probation === 'complete' || probation === 'canary' || probation === 'active' || probation === 'paused' || probation === 'suspended'
      ? probation
      : null;
  const onboardingSource = row?.fixture ? 'staging_fixture' : 'wa05_mock_onboarding';
  return {
    registrationSource: row?.registration_state
      ? row.onboarding
        ? onboardingSource
        : 'sms_registration'
      : null,
    companyId: row?.company_id ?? null,
    registrationState: row?.registration_state ?? null,
    industry: twilioIndustries.find((industry) => industry === row?.industry) ?? null,
    probationState,
    probationSource: probationState ? onboardingSource : null,
    setupPaymentSource:
      row?.payment_source === 'capture' || row?.payment_source === 'stripe_test' ? row.payment_source : null,
    // WA-05 only supports mock enrollment. WA-02 retains event kinds and digests, but
    // no paid amount, settlement time or live-mode flag. The gift ledger owns its receipts.
    firstClearedPaymentAt: null,
    firstClearedPaymentSource: null,
  };
}

const fixtureBrands = {
  studio: '1da09cbe-72b2-4b85-9420-34b900cfe188',
  orchard: '134a9c31-4aae-4774-b224-390c17c77980',
} as const;

/** Prepare only these reserved, non-Clerk identities for a local or hosted staging evidence runner. */
export async function seedStagingGiftAudience(db: Database, cohort: keyof typeof fixtureBrands) {
  if (
    !['test', 'local', 'staging'].includes(process.env.APP_ENV ?? '') ||
    !Object.hasOwn(fixtureBrands, cohort)
  )
    throw new Error('Gift audience evidence requires a staging or test fixture.');
  const workspaceId = 'fixture:gifting:audience:v1:' + cohort,
    brandId = fixtureBrands[cohort];
  await db.brand(workspaceId, brandId, async (sql) => {
    await lockWorkspace(sql, workspaceId);
    await sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      workspaceId,
      'Gift audience fixture',
    ]);
    await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
      workspaceId,
      brandId,
      'Gift audience fixture',
    ]);
    // Seed the same persisted projections the WA-05 reader consumes. There is no
    // provider registration, checkout receipt, or carrier job for these reserved IDs.
    const profile = {
      vertical: cohort === 'studio' ? 'RETAIL' : 'REAL_ESTATE',
      onboarding: { probation: { state: 'active', startsAt: new Date().toISOString() } },
    };
    await sql.query(
      `WITH added AS (
      INSERT INTO sms_carrier_brands(workspace_id,id,company_id,legal_name,entity_type,profile,help_contact,created_by)
      SELECT workspace_id,gen_random_uuid(),company_id,'Gift evidence fixture','private_profit',$3,
        'fixture@example.invalid','fixture:gifting:audience:v1' FROM company_brands WHERE workspace_id=$1 AND brand_id=$2
      ON CONFLICT (workspace_id,company_id) DO NOTHING RETURNING workspace_id,id
    ) INSERT INTO sms_registrations(workspace_id,id,carrier_brand_id,state)
      SELECT workspace_id,gen_random_uuid(),id,'approved' FROM added`,
      [workspaceId, brandId, profile],
    );

    // Only newly created fixture addresses receive exercise evidence. Replaying cannot
    // relabel an existing consent event, reconfirm an opt-out or replace a person ID.
    await sql.query(
      `WITH added AS (
      INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state,first_name,confirmed_at)
      SELECT $1,$2,gen_random_uuid(),'gift-'||n||'@example.invalid','confirmed','Fixture '||n,now()
      FROM generate_series(1,$3::int) n ON CONFLICT DO NOTHING RETURNING workspace_id,brand_id,id
    ) INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain)
      SELECT workspace_id,brand_id,gen_random_uuid(),id,'confirmed','gift_fixture','gift-fixture-v1',
        encode(sha256(convert_to('Synthetic gift audience fixture','UTF8')),'hex'),'customer-exercise-confirmation','example.invalid'
      FROM added`,
      [workspaceId, brandId, cohort === 'studio' ? 100 : 1],
    );
  });
  return { workspaceId, brandId };
}
