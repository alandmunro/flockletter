import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { Database } from '../src/server/db.js';

export async function verifyWorkspaceActivity(page: Page, origin: string, db: Database, workspace: string) {
  const draft = await db.tenant(workspace, async (sql) => (await sql.query<{id:string; brand_id:string; version:number}>(
    'SELECT id,brand_id,version FROM campaigns ORDER BY created_at,id LIMIT 1',
  )).rows[0]!);
  const rehearsal = randomUUID();
  await db.brand(workspace,draft.brand_id, (sql) => sql.query(`INSERT INTO campaign_rehearsals
    (workspace_id,brand_id,id,campaign_id,version,content,render_html,render_text,creator_id,actor_id,audience,state,access_revision,selected,excluded,due_at,period)
    VALUES ($1,$2,$3,$4,$5,'{}','','','synthetic-owner','synthetic-operation','test','queued',0,1,0,now()-interval '2 hours',CURRENT_DATE)`,
    [workspace,draft.brand_id,rehearsal,draft.id,draft.version]));
  let interrupted = false;
  await page.route('**/api/v1/commands/workspace.operations', async (route) => {
    if (interrupted) await route.fulfill({status:503,json:{error:{message:'Activity temporarily unavailable.'}}});
    else await route.continue();
  });
  await page.goto(origin);
  const workspaceButton = page.getByRole('button',{name:'Workspace',exact:true});
  await workspaceButton.click();
  const activity = page.getByRole('region',{name:'Workspace activity',exact:true});
  const overdue = activity.getByRole('listitem').filter({has:page.getByRole('heading',{name:'Overdue queued rehearsals (1)',exact:true})});
  await overdue.waitFor();
  const readRehearsal = page.waitForRequest((request) => new URL(request.url()).pathname==='/api/v1/commands/rehearsal.report');
  await overdue.getByText('Inspect affected rehearsal', {exact:true}).click();
  assert.deepEqual((await readRehearsal).postDataJSON(),{brandId:draft.brand_id,id:rehearsal});
  await overdue.getByText(/ · queued · due /).waitFor();
  const readCampaign = page.waitForRequest((request) => new URL(request.url()).pathname==='/api/v1/commands/campaign.get');
  await overdue.getByRole('button',{name:'Open affected campaign'}).click();
  assert.equal((await readCampaign).postDataJSON().id,draft.id);
  await page.getByRole('heading',{level:1,name:/Newsletter Studio|Campaign draft/}).waitFor();
  await workspaceButton.click();
  await overdue.waitFor();
  interrupted = true;
  await activity.getByRole('button',{name:'Refresh activity'}).click();
  await activity.getByText('Activity temporarily unavailable.').waitFor();
  assert.equal(await overdue.count(),0);
  await db.brand(workspace,draft.brand_id, (sql) => sql.query("UPDATE campaign_rehearsals SET state='completed',finished_at=now() WHERE id=$1",[rehearsal]));
  interrupted = false;
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname==='/api/v1/commands/workspace.operations' && response.ok());
  await activity.getByRole('button',{name:'Refresh activity'}).click();
  await refreshed;
  await activity.getByRole('heading',{name:'Staging rehearsal alerts'}).waitFor();
  assert.equal(await overdue.count(),0);
  assert.equal(await activity.getByRole('alert').count(),0);
}
