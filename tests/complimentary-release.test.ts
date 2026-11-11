import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import {CommandService,type Actor} from '../src/server/service.js';
import {complimentaryReleaseConfiguration,runComplimentaryRelease} from '../scripts/complimentary-release.js';
import {recordAccess} from '../scripts/complimentary-access.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database,admin:Database;
let productionUrl:string,stagingUrl:string;
const commit='a'.repeat(40);
const env=(environment='production',url=productionUrl)=>({APP_ENV:environment,RENDER_GIT_COMMIT:commit,MIGRATION_DATABASE_URL:url});
beforeAll(async()=>{
  fixture=await startDatabase();
  const root=new pg.Client({connectionString:fixture.adminUrl});await root.connect();
  try{
    const password=randomBytes(32).toString('hex');
    await root.query(`CREATE ROLE fixture_release_owner LOGIN CREATEDB CREATEROLE PASSWORD '${password}'`);
    for(const environment of ['production','staging']){
      await root.query(`CREATE DATABASE fixture_${environment}_control OWNER fixture_release_owner`);
      const url=new URL(fixture.adminUrl);url.username='fixture_release_owner';url.password=password;url.pathname=`/fixture_${environment}_control`;
      const runtimePassword=randomBytes(32).toString('hex'),migratorPassword=randomBytes(32).toString('hex');
      const input={adminUrl:url.href,expectedHost:url.hostname,expectedSource:`fixture_${environment}_control`,runtimePassword,migratorPassword,[environment==='production'?'confirmProduction':'confirmStaging']:true};
      const result=spawnSync(process.execPath,[`scripts/provision-${environment}.mjs`,'apply'],{input:JSON.stringify(input)+'\n',encoding:'utf8',timeout:30000,env:{...process.env,APP_ENV:environment}});
      expect(result.status,result.stderr).toBe(0);
      url.username=`flockletter_${environment}_migrator`;url.password=migratorPassword;url.pathname=`/flockletter_${environment}`;
      if(environment==='production'){
        productionUrl=url.href;admin=new Database(url.href);
        url.username='flockletter_production_runtime';url.password=runtimePassword;db=new Database(url.href);
      }else stagingUrl=url.href;
    }
  }finally{await root.end();}
});
afterAll(async()=>{await db?.close();await admin?.close();await fixture?.stop();});

async function target(){
  const workspaceId='org_'+randomUUID().replaceAll('-','');
  const actor:Actor={workspaceId,userId:'owner_fixture',actorId:'user:owner_fixture',owner:true,kind:'session',scopes:['read'],brandIds:null};
  const commands=new CommandService(db);
  await commands.execute('workspace.initialize',{operationKey:randomUUID(),name:'Fixture business',brandName:'Fixture brand'},actor);
  const brand=(await db.read(workspaceId,async sql=>(await sql.query<{id:string}>('SELECT id FROM brands')).rows[0]!)).id;
  const url=new URL(productionUrl);
  return {version:1 as const,environment:'production' as const,expectedHost:url.hostname,expectedPort:Number(url.port||5432),expectedCommit:commit,confirmApply:true,
    change:{workspaceId,plan:'growth' as const,operator:'Fixture operator',reason:'Approved isolated pilot',operationKey:randomUUID()},
    guard:{expectedRevision:0,expectedWorkspaceName:'Fixture business',expectedBrandId:brand,expectedBrandName:'Fixture brand',requireNoBillingHistory:true as const}};
}

it('rejects wrong environment, commit, host, port, database, role and driver overrides before connection',async()=>{
  const input=await target();
  for(const settings of [{...env(),APP_ENV:'staging'},{...env(),RENDER_GIT_COMMIT:'b'.repeat(40)},env('production',stagingUrl)])
    expect(()=>complimentaryReleaseConfiguration(input,settings,'apply')).toThrow();
  for(const change of [{expectedHost:'foreign.invalid'},{expectedPort:5433},{confirmApply:false},{extra:'unexpected'}])
    expect(()=>complimentaryReleaseConfiguration({...input,...change},env(),'apply')).toThrow();
  expect(()=>complimentaryReleaseConfiguration(input,env(),'unknown')).toThrow();
  for(const suffix of ['?host=foreign.invalid','?user=postgres','?sslmode=disable&sslmode=disable','#','#private-marker'])
    expect(()=>complimentaryReleaseConfiguration(input,env('production',productionUrl+suffix),'apply')).toThrow();
  const runtime=new URL(productionUrl);runtime.username='flockletter_production_runtime';
  expect(()=>complimentaryReleaseConfiguration(input,env('production',runtime.href),'apply')).toThrow();
});

it('inspects without writes, applies with a real restricted migration role and reports historical replay honestly',async()=>{
  const input=await target();
  expect(await runComplimentaryRelease({...input,confirmApply:false},env(),'inspect')).toMatchObject({ok:true,mode:'inspect',receipt:null,currentRevision:0,currentPlan:null});
  expect(await runComplimentaryRelease(input,env(),'apply')).toMatchObject({ok:true,replayed:false,receipt:{revision:1,plan:'growth'},currentRevision:1,currentPlan:'growth'});
  await recordAccess(admin,input.change.workspaceId,{...input.change,operationKey:randomUUID(),plan:null,reason:'Isolated revocation'}, {...input.guard,expectedRevision:1});
  expect(await runComplimentaryRelease(input,env(),'apply')).toMatchObject({ok:true,replayed:true,receipt:{revision:1,plan:'growth'},currentRevision:2,currentPlan:null});
  const rows=await db.read(input.change.workspaceId,async sql=>(await sql.query('SELECT revision,recorded_at FROM workspace_access_events ORDER BY revision')).rows);
  expect(rows.map(r=>r.revision)).toEqual([1,2]);expect(rows.every(r=>r.recorded_at instanceof Date)).toBe(true);
});

it('refuses unmarked or elevated release identities without a grant',async()=>{
  const input=await target(),root=new pg.Client({connectionString:fixture.adminUrl});await root.connect();
  try{
    await root.query("COMMENT ON ROLE flockletter_production_migrator IS 'Unreviewed fixture'");
    await expect(runComplimentaryRelease(input,env(),'apply')).rejects.toThrow('identity_invalid');
    await root.query("COMMENT ON ROLE flockletter_production_migrator IS 'Flockletter production foundation'");
    await root.query('ALTER ROLE flockletter_production_migrator CREATEROLE');
    await expect(runComplimentaryRelease(input,env(),'apply')).rejects.toThrow('identity_invalid');
  }finally{
    await root.query('ALTER ROLE flockletter_production_migrator NOCREATEROLE');
    await root.query("COMMENT ON ROLE flockletter_production_migrator IS 'Flockletter production foundation'");
    await root.end();
  }
  expect((await db.read(input.change.workspaceId,sql=>sql.query('SELECT FROM workspace_access_events'))).rowCount).toBe(0);
});

it('rechecks pending billing history after the workspace lock and never issues the competing grant',async()=>{
  const input=await target(),w=input.change.workspaceId;
  const writer=await db.pool.connect();
  let attempted:Promise<unknown>|undefined;
  try{
    await writer.query('BEGIN');await writer.query("SELECT set_config('app.workspace_id',$1,true)",[w]);
    await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[w]);
    attempted=recordAccess(admin,w,input.change,input.guard);
    // Observe rejection immediately to avoid an unhandled rejection during transaction cleanup.
    const result=attempted.then(()=>({accepted:true}),()=>({accepted:false}));
    await writer.query(`INSERT INTO customer_billing_intents(workspace_id,id,actor_id,operation_key,command,request_hash,provider_account)
      VALUES($1,$2,'owner_fixture',$3,'customerBilling.checkout','fixture_hash','acct_fixture')`,[w,randomUUID(),randomUUID()]);
    await writer.query('COMMIT');
    expect(await result).toEqual({accepted:false});
    expect((await db.read(w,sql=>sql.query('SELECT FROM workspace_access_events'))).rowCount).toBe(0);
  }finally{await writer.query('ROLLBACK');writer.release();await attempted?.catch(()=>{});}
});

it('CLI refuses an exposed target file and never prints credentials or private parse errors',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'flockletter-grant-cli-'));await chmod(directory,0o700);
  const file=join(directory,'target.json');
  try{
    await writeFile(file,JSON.stringify(await target()),{mode:0o644});
    const result=spawnSync(process.execPath,['--import','tsx','scripts/access-cli.ts','apply',file],{encoding:'utf8',timeout:10000,env:{...process.env,...env(),MIGRATION_DATABASE_URL:productionUrl+'?password=private-marker'}});
    expect(result.status).not.toBe(0);expect(result.stderr).toContain('reconcile before retrying');
    expect(result.stdout+result.stderr).not.toContain('private-marker');
    expect(result.stdout+result.stderr).not.toContain(new URL(productionUrl).password);
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('refuses subscription, provider-event and trial-card history without changing the billing records',async()=>{
  const history=[
    `INSERT INTO customer_subscriptions(workspace_id,id,source,state,plan,provider_account,provider_customer,provider_subscription)
      VALUES($1,$2::text::uuid,'stripe','active','starter','acct_fixture','cus_'||$2::text,'sub_'||$2::text)`,
    `INSERT INTO customer_billing_events(workspace_id,source,event_id,digest,provider_account,event_kind)
      VALUES($1,'stripe',$2,'fixture_digest','acct_fixture','invoice.paid')`,
    `INSERT INTO customer_trial_setups(workspace_id,id,actor_id,operation_key,plan,source,provider_account,registry_namespace,registry_workspace_digest,owner_digest,state)
      VALUES($1,$2,'fixture_owner',$2,'growth','stripe_live','acct_fixture','fixture_namespace','fixture_workspace_digest','fixture_owner_digest','pending')`,
  ];
  for(const statement of history){
    const input=await target(),w=input.change.workspaceId;
    await db.tenant(w,sql=>sql.query(statement,[w,randomUUID()]));
    await expect(runComplimentaryRelease(input,env(),'apply')).rejects.toThrow('billing history');
    expect((await db.read(w,sql=>sql.query('SELECT FROM workspace_access_events'))).rowCount).toBe(0);
  }
});
