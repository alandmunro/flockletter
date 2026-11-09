import type { Sql } from '../db.js';
import type { DeliveryOutcomesPage,DeliveryRecipientOutcome } from '../../shared/customer-delivery.js';
import { customerDeliveryCommands } from '../../shared/customer-delivery.js';
import { requireCondition } from '../errors.js';
import type { DeliveryRow } from './types.js';

type Input=ReturnType<typeof customerDeliveryCommands['delivery.outcomes']['schema']['parse']>;
/** A single statement binds page totals and items to the same observed database snapshot. */
export async function deliveryOutcomes(sql:Sql,row:DeliveryRow,input:Input):Promise<DeliveryOutcomesPage> {
  if(input.after)requireCondition((await sql.query('SELECT FROM customer_delivery_recipients WHERE delivery_id=$1 AND id=$2',
    [row.id,input.after])).rowCount,422,'outcome_cursor_unavailable','Restart this delivery’s results with its first page.');
  const result=(await sql.query<{total:number;items:DeliveryRecipientOutcome[];observed_at:Date}>(`
    WITH matching AS MATERIALIZED (
      SELECT id,state,feedback,reason,attempts FROM customer_delivery_recipients
      WHERE delivery_id=$1 AND ($2::text IS NULL OR state=$2) AND ($3::text IS NULL OR feedback=$3)
    ), page AS (
      SELECT * FROM matching WHERE $4::uuid IS NULL OR id>$4 ORDER BY id LIMIT $5
    )
    SELECT (SELECT count(*)::int FROM matching) total,
      coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM page p),'[]'::jsonb) items,
      statement_timestamp() observed_at`,[row.id,input.state??null,input.feedback??null,input.after??null,input.limit+1])).rows[0]!;
  const items=result.items.slice(0,input.limit);
  return {deliveryId:row.id,brandId:row.brand_id,mode:row.mode,items,total:result.total,
    nextCursor:result.items.length>input.limit?items.at(-1)!.id:null,observedAt:result.observed_at.toISOString()};
}
