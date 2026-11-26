import type {Sql} from '../db.js';

export async function recordWorkspacePayment(sql:Sql,workspace:string,live:boolean,reference:string,at:string) {
  await sql.query(`INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result)
    VALUES($1,$2,$3,$3,jsonb_build_object('at',$4::text)) ON CONFLICT DO NOTHING`,
    [workspace,'billing:cleared:'+ (live?'live':'test'),reference,at]);
}

export async function firstWorkspacePayment(sql:Sql,workspace:string,live:boolean) {
  const {rows}=await sql.query<{at:string}>(`SELECT result->>'at' AS at FROM operations
    WHERE workspace_id=$1 AND actor_id=$2 ORDER BY result->>'at' LIMIT 1`,
    [workspace,'billing:cleared:'+(live?'live':'test')]);
  return rows[0]?.at;
}
