import type {Sql} from '../db.js';
import type {DeliveryOptions,DeliveryRow} from './types.js';
import type {TestBudget} from '../../shared/customer-test-send.js';
import {requireCondition} from '../errors.js';
import {digest} from '../content.js';

/** UTC admission clock is database-owned and independent of billing exercise offsets. */
export async function testBudget(sql:Sql):Promise<TestBudget> {
 const row=(await sql.query<{day:string;used:number}>(`WITH observed AS MATERIALIZED(SELECT clock_timestamp() at)
  SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD') AS "day",
  (SELECT count(*)::int FROM customer_deliveries WHERE purpose='test' AND test_day=(observed.at AT TIME ZONE 'UTC')::date) used FROM observed`)).rows[0]!;
 return {...row,limit:5,remaining:Math.max(0,5-row.used)};
}
/** Caller holds the workspace lock and exact review row; the unique index is the final capacity backstop. */
export async function admitTest(sql:Sql,row:DeliveryRow) {
 const result=await sql.query(`WITH observed AS MATERIALIZED(SELECT clock_timestamp() at), available AS (
  SELECT slot FROM generate_series(1,5) slot CROSS JOIN observed o WHERE NOT EXISTS(
   SELECT FROM customer_deliveries d WHERE d.purpose='test' AND d.test_day=(o.at AT TIME ZONE 'UTC')::date AND d.test_slot=slot)
  ORDER BY slot LIMIT 1)
  UPDATE customer_deliveries d SET test_day=(o.at AT TIME ZONE 'UTC')::date,test_slot=a.slot,test_admitted_at=o.at
  FROM observed o,available a WHERE d.id=$1 AND d.brand_id=$2 AND d.purpose='test' AND d.state='reviewed' AND d.test_day IS NULL`,[row.id,row.brand_id]);
 requireCondition(result.rowCount===1,429,'test_daily_limit','This workspace has used all five approved test requests for this UTC day. Cancelled or rejected tests do not restore the daily allowance.');
}
export async function sameTestDay(sql:Sql,row:DeliveryRow) {
 if(row.purpose!=='test')return true;
 return Boolean((await sql.query<{allowed:boolean}>(`SELECT test_day IS NOT NULL AND test_day=(clock_timestamp() AT TIME ZONE 'UTC')::date allowed
  FROM customer_deliveries WHERE id=$1 AND brand_id=$2 AND purpose='test'`,[row.id,row.brand_id])).rows[0]?.allowed);
}
export async function testRecipient(sql:Sql,row:DeliveryRow,subscriberId:string|undefined,options:DeliveryOptions) {
 const candidates=(await sql.query<{subscriber_id:string;email_digest:string;email_normalized:string;state:string}>(`SELECT p.subscriber_id,p.email_digest,s.email_normalized,s.state
  FROM customer_delivery_recipients p JOIN subscribers s ON(s.workspace_id,s.brand_id,s.id)=(p.workspace_id,p.brand_id,p.subscriber_id)
  WHERE p.delivery_id=$1 AND p.brand_id=$2`,[row.id,row.brand_id])).rows;
 const person=candidates[0];
 const matches=row.purpose==='test'&&row.selected===1&&candidates.length===1&&(!subscriberId||person?.subscriber_id===subscriberId);
 return {matches,person,eligible:Boolean(matches&&person&&person.state==='confirmed'&&digest(person.email_normalized)===person.email_digest&&
  (row.mode==='capture'||await options.liveConsent?.(sql,person.subscriber_id)))};
}
