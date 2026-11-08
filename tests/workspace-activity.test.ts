import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Sql } from '../src/server/db.js';
import type { WorkspaceActivity } from '../src/shared/workspace-activity.js';
import { startDeliveryFixture } from './staging-delivery-fixture.js';

let f: Awaited<ReturnType<typeof startDeliveryFixture>>;
type Customer = Awaited<ReturnType<typeof f.workspace>>;
let owner: Customer, foreign: Customer;
const campaign = randomUUID(), oldest = randomUUID(), recent = randomUUID(), stopped = randomUUID();
const hidden = 'private-token@example.test';

async function seed(sql: Sql, workspace: string, brand: string) {
  await sql.query('INSERT INTO campaigns(workspace_id,id,brand_id,content) VALUES ($1,$2,$3,$4)',[workspace,campaign,brand,JSON.stringify({title:hidden})]);
  for (const [id, state, minutes] of [[oldest,'queued',-45],[recent,'queued',-20],[stopped,'blocked',-5],[randomUUID(),'queued',60]] as const) {
    await sql.query(`INSERT INTO campaign_rehearsals(workspace_id,brand_id,id,campaign_id,version,content,render_html,render_text,
      creator_id,actor_id,audience,state,access_revision,selected,excluded,due_at,period,transport,provider_binding,reason)
      VALUES ($1,$2,$3,$4,7,'{}',$5,$5,$5,$5,'test',$6,0,1,0,now()+$7::int*interval '1 minute',CURRENT_DATE,'feedback_test','local-feedback-v1',$5)`,
      [workspace,brand,id,campaign,hidden,state,minutes]);
  }
  await sql.query(`INSERT INTO rehearsal_reservations(workspace_id,brand_id,rehearsal_id,period,slots,messages)
    VALUES ($1,$2,$3,CURRENT_DATE,0,1)`,[workspace,brand,stopped]);
  const ambiguous = randomUUID(), negative = randomUUID();
  for (const [id, state, attempts, minutes] of [
    [ambiguous,'uncertain',1,1], [randomUUID(),'submitting',1,-1],
    [randomUUID(),'submitting',1,60], [randomUUID(),'submitting',0,-1], [negative,'accepted',1,1],
  ] as const) {
    await sql.query(`INSERT INTO rehearsal_recipients(workspace_id,brand_id,rehearsal_id,id,state,attempts,next_check_at,reason)
      VALUES ($1,$2,$3,$4,$5,$6,now()+$7::int*interval '1 minute',$8)`,[workspace,brand,recent,id,state,attempts,minutes,hidden]);
  }
  await sql.query(`INSERT INTO campaign_provider_receipts(workspace_id,brand_id,rehearsal_id,operation_key,provider_binding,message_id)
    VALUES ($1,$2,$3,$4,'local-feedback-v1',$5)`,[workspace,brand,recent,negative,hidden]);
  for (const kind of ['permanent_bounce','permanent_bounce','complaint','temporary_bounce','delivered']) {
    await sql.query(`INSERT INTO campaign_provider_events(workspace_id,brand_id,operation_key,kind,event_id)
      VALUES ($1,$2,$3,$4,$5)`,[workspace,brand,negative,kind,hidden+randomUUID()]);
  }
}
beforeAll(async () => {
  f = await startDeliveryFixture();
  owner = await f.workspace();
  foreign = await f.workspace();
});
afterAll(async () => {
  await owner?.close();
  await foreign?.close();
  await f?.close();
});

it('reports six scoped alert groups, counts distinct feedback and does not expose recipient data', async () => {
  const read = (customer:Customer) => customer.command<WorkspaceActivity>('workspace.operations',{});
  const clean = await read(owner);
  expect(clean.alerts).toEqual([]);
  expect(clean.emailDelivery).toBe('off');
  expect(Date.parse(clean.checkedAt)).toBeGreaterThan(0);
  // The other tenant reuses all resource IDs. Its records must never affect the first owner's activity.
  await f.db.tenant(foreign.workspaceId, (sql) => sql.query('INSERT INTO brands(workspace_id,id,name) VALUES ($1,$2,$3)',[foreign.workspaceId,owner.brandId,'Foreign-only brand']));
  await f.db.brand(foreign.workspaceId,owner.brandId,(sql) => seed(sql,foreign.workspaceId,owner.brandId));
  expect((await read(owner)).alerts).toEqual([]);
  await f.db.brand(owner.workspaceId,owner.brandId,(sql) => seed(sql,owner.workspaceId,owner.brandId));
  const active = await read(owner);
  expect(active.captures).toEqual({queued:3,overdue:2,blocked:1,captured:0});
  expect(Object.fromEntries(active.alerts.map((item) => [item.kind,item.count]))).toEqual({
    overdue:2,blocked:1,uncertain:2,held:1,hard_bounce:1,complaint:1,
  });
  expect(active.alerts.find((item) => item.kind==='overdue')).toMatchObject({rehearsalId:oldest,version:7});
  expect(active.alerts.every((item) => item.brandId===owner.brandId && item.campaignId===campaign)).toBe(true);
  expect(JSON.stringify(active)).not.toContain(hidden);
  expect(JSON.stringify(active)).not.toContain('Foreign-only brand');
  expect((await owner.post('workspace.operations',{brandId:foreign.brandId})).status).toBe(422);
  await expect(owner.tool('workspace_operations',{})).rejects.toThrow();
  const replay = await read(owner);
  expect(replay.events).toEqual(active.events);
  expect(replay.alerts).toEqual(active.alerts);

  await f.db.brand(owner.workspaceId,owner.brandId,async (sql) => {
    await sql.query("UPDATE campaign_rehearsals SET state='completed' WHERE id=ANY($1::uuid[])",[[oldest,recent]]);
    await sql.query("UPDATE rehearsal_recipients SET state='accepted' WHERE rehearsal_id=$1",[recent]);
    await sql.query('UPDATE rehearsal_reservations SET settled=true WHERE rehearsal_id=$1',[stopped]);
  });
  const resolved = await read(owner);
  expect(resolved.alerts.map((a) => a.kind)).toEqual(['blocked','complaint','hard_bounce']);
  const unaffected = await read(foreign);
  expect(unaffected.alerts.find((a) => a.kind==='overdue')).toMatchObject({count:2,brandName:'Foreign-only brand'});
});
