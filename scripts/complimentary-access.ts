import { z } from 'zod';
import { Database, type Sql } from '../src/server/db.js';
import { workspaceIdentifier } from '../src/server/campaign/rehearsal.js';
import { lockWorkspace } from '../src/server/workspace-lock.js';

export const accessChange = z
  .object({
    workspaceId: workspaceIdentifier,
    plan: z.enum(['starter', 'growth', 'pro']).nullable(),
    operator: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(1).max(240),
    operationKey: z.uuid(),
  })
  .strict();
export const accessGuard = z.object({
  expectedRevision:z.number().int().nonnegative(),
  expectedWorkspaceName:z.string().trim().min(1).max(150),
  expectedBrandId:z.uuid(), expectedBrandName:z.string().trim().min(1).max(150),
  requireNoBillingHistory:z.boolean(),
}).strict();
type Guard=z.infer<typeof accessGuard>;
type Change=z.infer<typeof accessChange>;
type AccessEvent={revision:number;plan:Change['plan'];operator_name:string;reason:string};

async function inspectLocked(sql:Sql,target:string,change:Change,guard?:Guard) {
  await lockWorkspace(sql,target);
  const workspace=(await sql.query<{name:string}>('SELECT name FROM workspaces WHERE workspace_id=$1',[target])).rows[0];
  if(!workspace)throw Error('Initialize the target workspace first.');
  const prior=(await sql.query<AccessEvent>('SELECT * FROM workspace_access_events WHERE workspace_id=$1 AND operation_key=$2',[target,change.operationKey])).rows[0];
  if(prior&&(prior.plan!==change.plan||prior.operator_name!==change.operator||prior.reason!==change.reason))
    throw Error('Operation key already used for a different grant.');
  const latest=(await sql.query<AccessEvent>('SELECT * FROM workspace_access_events WHERE workspace_id=$1 ORDER BY revision DESC LIMIT 1',[target])).rows[0];
  let brand:{id:string;name:string}|undefined;
  if(guard){
    brand=(await sql.query<{id:string;name:string}>('SELECT id,name FROM brands WHERE id=$1 AND workspace_id=$2',[guard.expectedBrandId,target])).rows[0];
    if(workspace.name!==guard.expectedWorkspaceName||!brand||brand.name!==guard.expectedBrandName)
      throw Error('The reviewed workspace or brand has changed.');
    // A known replay reports its original receipt; it never reinstates a later-revoked grant.
    if(!prior&&(latest?.revision??0)!==guard.expectedRevision)throw Error('The reviewed access revision has changed.');
  }
  if(change.plan&&!prior){
    const strict=guard?.requireNoBillingHistory===true;
    const history=(await sql.query<{present:boolean}>(`SELECT
      EXISTS(SELECT FROM sandbox_checkouts WHERE workspace_id=$1) OR
      EXISTS(SELECT FROM customer_subscriptions WHERE workspace_id=$1 AND ($2 OR source='stripe')) OR
      EXISTS(SELECT FROM customer_billing_intents WHERE workspace_id=$1 AND ($2 OR provider_account IS NOT NULL)) OR
      EXISTS(SELECT FROM customer_billing_events WHERE workspace_id=$1 AND ($2 OR source='stripe')) OR
      EXISTS(SELECT FROM customer_trial_setups WHERE workspace_id=$1 AND ($2 OR source IN ('stripe_test','stripe_live')))
      AS present`,[target,strict])).rows[0];
    if(history?.present)throw Error('A workspace with billing history cannot be enrolled as a Stripe-bypassing complimentary account.');
  }
  return {prior,details:{workspaceId:target,workspaceName:workspace.name,brandId:brand?.id??null,
    brandName:brand?.name??null,currentRevision:Number(latest?.revision??0),currentPlan:latest?.plan??null,
    requestedPlan:change.plan,replayed:!!prior}};
}

function validated(target:string,raw:unknown,guard?:Guard){
  workspaceIdentifier.parse(target);
  const change=accessChange.parse(raw);
  if (change.workspaceId !== target)
    throw Error('The operator target must match the configured complimentary workspace.');
  return {change,guard:guard===undefined?undefined:accessGuard.parse(guard)};
}

/** Protected release inspection only: locks the same workspace but writes no event. */
export async function inspectAccess(db:Database,target:string,raw:unknown,guard:Guard){
  const checked=validated(target,raw,guard);
  return db.tenant(target,async sql=>(await inspectLocked(sql,target,checked.change,checked.guard)).details);
}

export async function recordAccess(db: Database, target: string, raw: unknown, guard?:Guard) {
  const checked=validated(target,raw,guard),change=checked.change;
  return db.tenant(target, async (sql) => {
    const {prior}=await inspectLocked(sql,target,change,checked.guard);
    if (prior) {
      return { revision: Number(prior.revision), plan: prior.plan };
    }
    const row = (
      await sql.query(
        `INSERT INTO workspace_access_events(workspace_id,revision,operation_key,plan,operator_name,reason)
      SELECT $1,coalesce(max(revision),0)+1,$2,$3,$4,$5 FROM workspace_access_events WHERE workspace_id=$1 RETURNING revision,plan`,
        [target, change.operationKey, change.plan, change.operator, change.reason],
      )
    ).rows[0]!;
    return { revision: Number(row.revision), plan: row.plan };
  });
}
