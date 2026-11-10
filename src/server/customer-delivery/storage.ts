import {mapDeliveryViews,type DeliveryGroupRow,type DeliveryRecipientRow} from './report-mapping.js';
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
  const row=(await sql.query<DeliveryRow>('SELECT *,test_day::text AS test_day FROM customer_deliveries WHERE id=$1 AND brand_id=$2 FOR UPDATE',[id,brand])).rows[0];
  requireCondition(row,404,'delivery_unavailable','This delivery is unavailable for this brand.');
  return row;
}
/** Batch only bounded aggregate facts and the first 50 opaque outcomes for each visible delivery. */
export async function deliveryViews(sql:Sql,rows:DeliveryRow[]):Promise<DeliveryView[]> {
  if(!rows.length)return [];
  requireCondition(rows.length<=100,422,'report_batch_limit','Read at most 100 delivery summaries at once.');
  const params=[rows.map(row=>row.workspace_id),rows.map(row=>row.brand_id),rows.map(row=>row.id)];
  const requested=`WITH requested AS (SELECT DISTINCT * FROM unnest($1::text[],$2::uuid[],$3::uuid[]) r(workspace_id,brand_id,delivery_id))`;
  const people=(await sql.query<DeliveryGroupRow>(requested+`
    SELECT p.workspace_id,p.brand_id,p.delivery_id,p.state,p.feedback,count(*)::int n
    FROM customer_delivery_recipients p JOIN requested r USING(workspace_id,brand_id,delivery_id)
    GROUP BY p.workspace_id,p.brand_id,p.delivery_id,p.state,p.feedback`,params)).rows;
  // Sequential queries on one checked-out pg client; LATERAL bounds retrieval inside PostgreSQL.
  const recipients=(await sql.query<DeliveryRecipientRow>(requested+`
    SELECT r.workspace_id,r.brand_id,r.delivery_id,p.id,p.state,p.feedback,p.reason,p.attempts
    FROM requested r CROSS JOIN LATERAL (
      SELECT p.id,p.state,p.feedback,p.reason,p.attempts FROM customer_delivery_recipients p
      WHERE (p.workspace_id,p.brand_id,p.delivery_id)=(r.workspace_id,r.brand_id,r.delivery_id)
      ORDER BY p.id LIMIT 50
    ) p ORDER BY r.workspace_id,r.brand_id,r.delivery_id,p.id`,params)).rows;
  return mapDeliveryViews(rows,people,recipients);
}
export async function deliveryView(sql:Sql,row:DeliveryRow):Promise<DeliveryView> {
  return (await deliveryViews(sql,[row]))[0]!;
}
export async function originalEnvelope(sql:Sql,row:DeliveryRow,person:PersonRow,address:string):Promise<DeliveryEnvelope|null> {
  const images:DeliveryEnvelope['images']=[];
  for(const expected of row.asset_digests) {
    const image=(await sql.query<DeliveryEnvelope['images'][number]>('SELECT name,mime,sha256,bytes FROM assets WHERE id=$1 AND brand_id=$2',[expected.id,row.brand_id])).rows[0];
    if(!image || image.sha256!==expected.sha256 || createHash('sha256').update(image.bytes).digest('hex')!==expected.sha256)return null;
    images.push(image);
  }
  return {purpose:row.purpose,operationKey:person.id,workspaceId:row.workspace_id,brandId:row.brand_id,to:address,
    subject:row.content.subject,html:row.rendered_html,text:row.rendered_text,images,
    ...(row.sender_profile?{sender:{name:row.sender_profile.fromName,replyTo:row.sender_profile.replyTo}}:{})};
}
export async function audit(sql:Sql,actor:Actor,action:string,resource:string|null) {
  await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
    [actor.workspaceId,randomUUID(),actor.actorId,action,resource]);
}
