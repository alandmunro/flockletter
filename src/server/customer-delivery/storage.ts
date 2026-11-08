import {lockWorkspace} from '../workspace-lock.js';
import { randomUUID,createHash } from 'node:crypto';
import type { Database,Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import type { Actor } from '../service.js';
import type { DeliveryRow,PersonRow } from './types.js';
import type { DeliveryView } from '../../shared/customer-delivery.js';
import type { DeliveryEnvelope } from '../campaign/delivery-provider.js';
import { permittedBrand } from './types.js';

export async function locked<T>(db:Database,workspace:string,run:(sql:Sql)=>Promise<T>):Promise<T> {
  return db.tenant(workspace,async sql=>{
    await lockWorkspace(sql,workspace);
    return run(sql);
  });
}
export async function brandScope(sql:Sql,actor:Actor,brand:string) {
  requireCondition(permittedBrand(actor,brand) &&
    (await sql.query('SELECT id FROM brands WHERE id=$1',[brand])).rowCount,
    404,'brand_unavailable','Choose an available brand in this workspace.');
  await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[brand]);
}
export async function deliveryRow(sql:Sql,id:string,brand:string):Promise<DeliveryRow> {
  const row=(await sql.query<DeliveryRow>('SELECT * FROM customer_deliveries WHERE id=$1 AND brand_id=$2 FOR UPDATE',[id,brand])).rows[0];
  requireCondition(row,404,'delivery_unavailable','This delivery is unavailable for this brand.');
  return row;
}
export async function deliveryView(sql:Sql,row:DeliveryRow):Promise<DeliveryView> {
  const recipients=(await sql.query<DeliveryView['recipients'][number]>('SELECT id,state,feedback,reason,attempts FROM customer_delivery_recipients WHERE delivery_id=$1 ORDER BY id LIMIT 50',[row.id])).rows;
  const people=(await sql.query<{state:string;feedback:string|null;n:number}>(
    'SELECT state,feedback,count(*)::int n FROM customer_delivery_recipients WHERE delivery_id=$1 GROUP BY state,feedback',[row.id])).rows;
  const count=(...states:string[])=>people.filter(p=>states.includes(p.state)).reduce((n,p)=>n+p.n,0);
  const feedback=(kind:string)=>people.filter(p=>p.feedback===kind).reduce((n,p)=>n+p.n,0);
  return {id:row.id,brandId:row.brand_id,campaignId:row.campaign_id,version:row.version,subject:row.content.subject,senderProfile:row.sender_profile,
    state:row.state,mode:row.mode,dueAt:row.due_at.toISOString(),selected:row.selected,excluded:row.excluded,
    pending:count('pending','prepared'),preparing:count('preparing'),submitting:count('submitting'),accepted:count('accepted'),
    uncertain:count('uncertain'),rejected:count('rejected'),skipped:count('excluded','cancelled'),
    delivered:feedback('delivered'),hardBounced:feedback('hard_bounce'),complained:feedback('complaint'),
    createdAt:row.created_at.toISOString(),reason:row.reason,recipients};
}
export async function originalEnvelope(sql:Sql,row:DeliveryRow,person:PersonRow,address:string):Promise<DeliveryEnvelope|null> {
  const images:DeliveryEnvelope['images']=[];
  for(const expected of row.asset_digests) {
    const image=(await sql.query<DeliveryEnvelope['images'][number]>('SELECT name,mime,sha256,bytes FROM assets WHERE id=$1 AND brand_id=$2',[expected.id,row.brand_id])).rows[0];
    if(!image || image.sha256!==expected.sha256 || createHash('sha256').update(image.bytes).digest('hex')!==expected.sha256)return null;
    images.push(image);
  }
  return {operationKey:person.id,workspaceId:row.workspace_id,brandId:row.brand_id,to:address,
    subject:row.content.subject,html:row.rendered_html,text:row.rendered_text,images,
    ...(row.sender_profile?{sender:{name:row.sender_profile.fromName,replyTo:row.sender_profile.replyTo}}:{})};
}
export async function audit(sql:Sql,actor:Actor,action:string,resource:string|null) {
  await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
    [actor.workspaceId,randomUUID(),actor.actorId,action,resource]);
}
