import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { acceptEnrollmentPlan, PracticeTextBilling, practicePlanLimits } from '../src/server/texting/commercial.js';
import { Texting } from '../src/server/texting/service.js';
import { queueText } from '../src/server/texting/messaging.js';
import type { PracticeReport, RecipientReport } from '../src/shared/texting-reports.js';
import { lockWorkspace } from '../src/server/workspace-lock.js';
import { setupFeeFor, type PracticePlanStatus, type TextPlan } from '../src/shared/texting-commercial.js';

const owner = (workspaceId: string): Actor => ({ kind: 'session', workspaceId, actorId: 'user:' + workspaceId, userId: 'user_' + workspaceId, owner: true, scopes: ['read'], brandIds: null });
const a = owner('org_practice_text_plan_a'), b = owner('org_practice_text_plan_b'), c = owner('org_practice_text_plan_c');
const isOwner = async (userId: string, workspace: string) => userId === 'user_' + workspace;
let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, billing: PracticeTextBilling, texting: Texting;
let now = new Date('2026-11-15T12:00:00Z');
const ids = new Map<string, { company: string; brand: string; registration: string }>();
const status = (actor: Actor) => billing.execute('sms.planStatus', {}, actor, 'ui') as Promise<PracticePlanStatus>;
async function reserve(actor: Actor, plan: TextPlan) {
  const id = ids.get(actor.workspaceId)!;
  return db.tenant(actor.workspaceId, async sql => {
    await lockWorkspace(sql, actor.workspaceId);
    await acceptEnrollmentPlan(sql, actor.workspaceId, id.company, plan, actor.actorId, 'ui', now, id.registration);
  });
}
async function approve(actor: Actor, tier: string) {
  const { registration, brand } = ids.get(actor.workspaceId)!;
  await db.tenant(actor.workspaceId, async sql => {
    await sql.query(`UPDATE sms_registrations SET state='approved',brand_status='APPROVED',campaign_status='VERIFIED' WHERE id=$1`, [registration]);
    await sql.query(`UPDATE sms_registration_steps SET facts=jsonb_build_object('tier',$1::text) WHERE registration_id=$2 AND step='brand'`, [tier, registration]);
    await sql.query(`UPDATE sms_numbers SET state='active' WHERE carrier_brand_id=$1`, [brand]);
  });
}
beforeAll(async () => {
  fixture = await startDatabase(); db = new Database(fixture.url); billing = new PracticeTextBilling(db, () => now, 'https://example.test');
  const service = new CommandService(db, undefined, isOwner);
  texting = Texting.mock(db, { origin: 'https://example.test', linkOrigin: 'https://example.test/l', isOwner, onboardingCapture: true, now: () => now });
  for (const [index,actor] of [a,b,c].entries()) {
    const w = actor.workspaceId;
    await service.execute('workspace.initialize', { operationKey: randomUUID(), name: 'Practice', brandName: 'Practice' }, actor);
    await db.tenant(w, async sql => {
      const company = (await sql.query<{ id: string }>('SELECT id FROM companies')).rows[0]!.id;
      const brand = randomUUID(), registration = randomUUID(), mockAccount = await texting.mock!.platform.createSubaccount(randomUUID(), w);
      const account = mockAccount.value!; await sql.query('SELECT flockletter_customer_jobs.texting_bind_account($1,$2,$3)', [w, account.accountSid, texting.options.seal.seal(account, w)]); ids.set(w, { company, brand, registration });
      await sql.query(`INSERT INTO sms_carrier_brands(workspace_id,id,company_id,legal_name,entity_type,profile,help_contact,created_by)
        VALUES($1,$2,$3,'Synthetic Practice','private_profit','{"onboarding":{},"registrationType":"ein","campaign":{"description":"Practice marketing for opted-in contacts","samples":["Example business update"]},"privacyPolicyUrl":"https://example.test/privacy","smsTermsUrl":"https://example.test/terms"}','help@example.test','fixture')`,[w,brand,company]);
      await sql.query(`INSERT INTO sms_registrations(workspace_id,id,carrier_brand_id,state,account_sid,brand_sid,customer_profile_sid,messaging_service_sid,campaign_sid) VALUES($1,$2,$3,'campaign_pending',$4,$5,'BUprofile','MGfixture','QEoriginal')`,[w,registration,brand,account.accountSid,'BN'+index]);
      await sql.query(`INSERT INTO sms_registration_steps(workspace_id,registration_id,revision,step,operation_key,state) VALUES($1,$2,1,'brand',$3,'done')`,[w,registration,randomUUID()]);
      await sql.query(`INSERT INTO sms_registration_steps(workspace_id,registration_id,revision,step,operation_key,state,provider_sid,facts)
        VALUES($1,$2,1,'customer_profile',$3,'done','BUprofile','{"parentSid":"BUproduct"}')`,[w,registration,randomUUID()]);
      await sql.query(`INSERT INTO sms_numbers(workspace_id,id,carrier_brand_id,e164,provider_sid,messaging_service_sid,state) VALUES($1,$2,$3,$4,'PNfixture','MGfixture','reserved')`,[w,randomUUID(),brand,'+1212555010'+index]);
    });
  }
});
afterAll(async()=> { await db?.close(); await fixture?.stop(); });

it('captures setup once and enforces a workspace agreement across approval, upgrades, renewal and cancellation', async () => {
  await Promise.all([reserve(a, 'text_300'), reserve(a, 'text_300')]);
  expect(await status(a)).toMatchObject({ revision: 1, active: null, setupFeeUsdCents: 4900, spendUsdCents: 4900, hold: 'texting_plan_pending' });
  expect(await status(b)).toBeNull();
  await billing.tick(a.workspaceId);
  expect((await status(a)).state).toBe('pending_registration');
  await approve(a, 'low_volume'); await billing.tick(a.workspaceId);
  const active = await status(a);
  expect(active).toMatchObject({ active: 'text_300', monthlyFeeUsdCents: 1900, setupFeeUsdCents: 4900, allowance: 300 });
  const change = { operationKey: randomUUID(), expectedRevision: active.revision, plan: 'text_1000', acceptedMonthlyUsdCents: 3900 };
  const [first,dup] = await Promise.all([billing.execute('sms.planChange', change, a, 'ui'), billing.execute('sms.planChange', change, a, 'ui')]);
  expect(first).toEqual(dup);
  expect(await status(a)).toMatchObject({ active: 'text_1000', allowance: 1000, monthlyFeeUsdCents: 1900 + 1033 });
  await db.tenant(a.workspaceId, sql => sql.query(`INSERT INTO sms_usage(workspace_id,period_month,segments_used,segments_reserved) VALUES($1,'2026-11-01',999,1)`,[a.workspaceId]));
  expect(await status(a)).toMatchObject({used:999,reserved:1});
  const capRequest = { operationKey: randomUUID(), expectedRevision: (await status(a)).revision, capUsdCents: (await status(a)).spendUsdCents };
  await billing.execute('sms.planCap', capRequest, a, 'ui');
  const limits = () => db.read(a.workspaceId, sql => practicePlanLimits(sql, a.workspaceId, now, 800));
  expect(await limits()).toEqual({ allowance: 800, hold: 'texting_spend_cap' });
  const heldId = await db.tenant(a.workspaceId, sql => queueText(sql, a.workspaceId, { companyId: ids.get(a.workspaceId)!.company,
    contactId: null, purpose: 'verification', to: '+12125550167', body: 'Practice verification', dueAt: now }));
  await texting.messaging.tick(a.workspaceId);
  const heldMessage = () => db.read(a.workspaceId, async sql => (await sql.query('SELECT state,attempts,reason FROM sms_messages WHERE id=$1', [heldId])).rows[0]);
  expect(await heldMessage()).toEqual({state:'pending',attempts:0,reason:'texting_spend_cap'});
  await expect(billing.execute('sms.planCap', { ...capRequest, operationKey: randomUUID() }, a, 'ui')).rejects.toMatchObject({code:'revision_conflict'});
  await billing.execute('sms.planChange',{ operationKey:randomUUID(), expectedRevision:(await status(a)).revision, plan:'text_2500', acceptedMonthlyUsdCents:7900 },a,'ui');
  await billing.tick(a.workspaceId);
  expect(await status(a)).toMatchObject({active:'text_1000', upgradeFailure:null, change:'standard_review', allowance:1000});
  for (let i = 0; i < 5; i++) { now = new Date(+now + 5000); await billing.tick(a.workspaceId); }
  expect(await status(a)).toMatchObject({active:'text_2500', change:null, allowance:2500});
  await billing.execute('sms.planChange',{ operationKey:randomUUID(), expectedRevision:(await status(a)).revision, plan:'text_300', acceptedMonthlyUsdCents:1900 },a,'ui');
  expect(await status(a)).toMatchObject({active:'text_2500', change:'renewal'});
  now = new Date('2026-12-01T00:00:00Z'); await billing.tick(a.workspaceId);
  const renewal = await status(a);
  expect(renewal).toMatchObject({active:'text_300', change:null, setupFeeUsdCents:0, monthlyFeeUsdCents:1900, used:0,reserved:0,hold:null});
  await billing.execute('sms.planCancel', { operationKey:randomUUID(), expectedRevision:renewal.revision, confirm:true }, a, 'ui');
  expect(await limits()).toEqual({allowance:0,hold:'texting_plan_cancelled'});
  expect(await heldMessage()).toEqual({state:'cancelled',attempts:0,reason:'texting_plan_cancelled'});
  const restore = () => status(a).then(s => texting.execute('sms.planReactivate', {operationKey: randomUUID(), expectedRevision:s.revision,acceptedMonthlyUsdCents:1900},a,'api'));
  expect(await restore()).toMatchObject({state:'active',monthlyFeeUsdCents:1900,setupFeeUsdCents:0});
  expect((await heldMessage()).state).toBe('cancelled');
  expect(await db.read(a.workspaceId, sql => practicePlanLimits(sql, a.workspaceId, now, 800, new Date('2026-11-30T22:00:00Z')))).toMatchObject({hold:'texting_plan_cancelled'});
  await billing.execute('sms.planCancel', {operationKey: randomUUID(), expectedRevision:(await status(a)).revision, confirm:true},a,'ui');
  now = new Date('2027-01-01T00:00:00Z');
  await expect(restore()).rejects.toMatchObject({code:'reactivation_unavailable'});
  expect(await db.read(a.workspaceId, async sql=>(await sql.query('SELECT id FROM brands')).rowCount)).toBe(1);
});

it('requires matching Standard approval, current owner and captured enrollment mode', async()=> {
  expect(setupFeeFor('text_2500')).toEqual({amount:9900,currency:'USD'});
  await reserve(b,'text_2500'); await approve(b,'low_volume'); await billing.tick(b.workspaceId);
  expect(await status(b)).toMatchObject({state:'pending_registration',setupFeeUsdCents:9900});
  await approve(b,'standard'); await billing.tick(b.workspaceId);
  expect(await status(b)).toMatchObject({active:'text_2500',monthlyFeeUsdCents:7900,allowance:2500});
  await expect(texting.execute('sms.planStatus',{}, {...b,userId:'departed'},'api')).rejects.toMatchObject({code:'owner_required'});
  expect(await texting.execute('sms.status', {}, {...b,userId:'departed'}, 'api')).toMatchObject({practicePlan:null});
  const disabled = Texting.mock(db,{origin:'https://example.test',linkOrigin:'https://example.test/l',isOwner});
  await expect(disabled.execute('sms.planStatus',{}, b,'api')).rejects.toMatchObject({code:'texting_plan_unavailable'});
  expect(await texting.execute('sms.planStatus',{}, c,'api')).toBeNull();
});

it('reports actual mock receipts, failed and held recipients within UTC dates and enforces tenant, company and owner visibility', async () => {
  const companyId = ids.get(c.workspaceId)!.company, sendId = randomUUID();
  const dates = { companyId, from:'2026-11-01', through:'2026-11-30' };
  await db.tenant(c.workspaceId, async sql => {
    await sql.query(`INSERT INTO sms_sends(workspace_id,id,company_id,kind,body,state,created_by,created_at)
      VALUES($1,$2,$3,'broadcast','Practice first broadcast','running','fixture','2026-11-30 23:59:59.999Z'),
            ($1,$4,$3,'broadcast','Following month','draft','fixture','2026-12-01 00:00:00Z')`,[c.workspaceId,sendId,companyId,randomUUID()]);
    for (const [i, state] of ['failed','pending','pending','uncertain','delivered'].entries()) {
      const id = await queueText(sql,c.workspaceId,{sendId,companyId,contactId:null,purpose:'broadcast',to:'+1212555016'+i,body:'Synthetic marketing',dueAt:now});
      const receipt = state === 'failed' || state === 'delivered';
      await sql.query(`UPDATE sms_messages SET state=$2,reason=$3,attempts=$4,provider_sid=$5 WHERE id=$1`,
        [id,state,state==='pending'?'probation_canary':null,state==='pending'?0:1,receipt?'SM'+id:null]);
    }
  });
  const report = await texting.execute('sms.practiceReport',dates,c,'api') as PracticeReport;
  expect(report.totals).toEqual({recipients:5,carrierReceipts:2,receiptSegments:2,delivered:1,failed:1,pending:2,held:2,uncertain:1,skipped:0,cancelled:0});
  expect(report.campaigns.map(row=>row.id)).toEqual([sendId]);
  expect((await texting.execute('sms.practiceReport',{...dates,from:'2026-12-01',through:'2026-12-01'},c,'ui') as PracticeReport).totals.recipients).toBe(0);
  const input = {companyId,sendId};
  const result = await texting.execute('sms.practiceRecipients',input,c,'ui') as RecipientReport;
  expect(result.recipients.filter(row=>row.state==='pending')).toHaveLength(2);
  expect(result.recipients.filter(row=>row.state==='pending').every(row=>row.attempts===0 && row.reason==='probation_canary')).toBe(true);
  expect(result.recipients.find(row=>row.state==='failed')?.phone).toBe('+12125550160');
  for (const actor of [a,{...c,brandIds:[]}]) {
    await expect(texting.execute('sms.practiceReport',dates,actor,'api')).rejects.toMatchObject({code:'not_found'});
    await expect(texting.execute('sms.practiceRecipients',input,actor,'api')).rejects.toMatchObject({code:'not_found'});
  }
  expect((await texting.execute('sms.practiceReport',dates,{...c,owner:false},'api') as PracticeReport).totals.failed).toBe(1);
  await expect(texting.execute('sms.practiceRecipients',input,{...c,owner:false},'api')).rejects.toMatchObject({code:'owner_required'});
  await expect(texting.execute('sms.practiceRecipients',input,{...c,userId:'departed'},'api')).rejects.toMatchObject({code:'owner_required'});
  await expect(texting.execute('sms.practiceReport',{...dates,through:'2028-01-01'},c,'api')).rejects.toThrow();
  const disabled = Texting.mock(db,{origin:'https://example.test',linkOrigin:'https://example.test/l',isOwner});
  await expect(disabled.execute('sms.practiceReport',dates,c,'ui')).rejects.toMatchObject({code:'capture_report_unavailable'});
});
