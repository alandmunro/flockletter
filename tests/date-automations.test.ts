import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService,type Actor } from '../src/server/service.js';
import { DateAutomations } from '../src/server/date-automations/service.js';
import type { Workspace } from '../src/shared/contracts.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database, dates:DateAutomations, brand:string;
const actor:Actor={workspaceId:'org_dates',userId:'owner',actorId:'user:owner',owner:true,kind:'session',brandIds:null,scopes:['read']};
const settings={time:'10:00',zone:'America/New_York',startHour:9,endHour:20,sms:'Happy {{label}}',email:null};
beforeAll(async()=>{
  fixture=await startDatabase(); db=new Database(fixture.url); await db.verifyBoundary();
  const service=new CommandService(db);
  await service.execute('workspace.initialize',{name:'Date fixtures',brandName:'First brand',operationKey:randomUUID()},actor);
  brand=((await service.execute('workspace.get',{},actor)) as Workspace).brands[0]!.id;
  dates=new DateAutomations(db,'capture',async user=>user==='owner');
});
afterAll(async()=>{await db?.close();await fixture?.stop();});
it('previews an empty brand without creating a definition or occurrence',async()=>{
  const list=()=>dates.execute('dateAutomation.list',{brandId:brand},actor);
  const upcoming=()=>dates.execute('dateAutomation.occurrences',{brandId:brand,view:'upcoming'},actor);
  const before=await list();
  expect(await upcoming()).toEqual({rows:[]});
  expect(await dates.execute('dateAutomation.preview',{brandId:brand,kind:'anniversary',settings,cursor:null},actor))
    .toEqual({rows:[],next:null});
  expect(await list()).toEqual(before);
  expect(await upcoming()).toEqual({rows:[]});
});
it('replays draft writes and binds recurring approval to a current owner and a saved revision',async()=>{
  const input={operationKey:randomUUID(),kind:'birthday',expectedRevision:0,brandId:brand,settings};
  expect(await dates.execute('dateAutomation.save',input,actor)).toEqual({kind:'birthday',revision:1});
  expect(await dates.execute('dateAutomation.save',input,actor)).toEqual({kind:'birthday',revision:1});
  const activate={kind:'birthday',brandId:brand,expectedRevision:1,operationKey:randomUUID(),confirmRecurring:true};
  await expect(dates.execute('dateAutomation.activate',{...activate,expectedRevision:0},actor)).rejects.toMatchObject({code:'version_conflict'});
  await expect(dates.execute('dateAutomation.activate',activate,{...actor,brandIds:[]})).rejects.toMatchObject({code:'brand_unavailable'});
  await dates.execute('dateAutomation.activate',activate,actor);
  expect(await dates.execute('dateAutomation.list',{brandId:brand},actor)).toMatchObject({definitions:[{enabled:true,revision:1}]});
  await dates.execute('dateAutomation.pause',{kind:'birthday',brandId:brand,expectedRevision:1,operationKey:randomUUID()},actor);
  expect(await dates.execute('dateAutomation.list',{brandId:brand},actor)).toMatchObject({definitions:[{enabled:false}]});
});

it('replans an edited date, preserves a cancelled year across concurrent passes, and expires missed greetings',async()=>{
  const {planBrand}=await import('../src/server/date-automations/planner.js');
  const {setDate}=await import('../src/server/subscribers/people.js');
  const kind='anniversary', day=new Date('2030-01-05T16:00:00Z'), reader=randomUUID();
  await dates.execute('dateAutomation.save',{kind,settings,brandId:brand,expectedRevision:0,operationKey:randomUUID()},actor);
  await dates.execute('dateAutomation.activate',{kind,brandId:brand,confirmRecurring:true,expectedRevision:1,operationKey:randomUUID()},actor);
  await db.brand(actor.workspaceId,brand,async sql=>{
    await sql.query('UPDATE date_automations SET activated_at=$1,next_scan=$1 WHERE kind=$2',[new Date('2030-01-02'),kind]);
    await sql.query("INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'date@example.test','confirmed')",[actor.workspaceId,brand,reader]);
    await setDate(sql,actor.workspaceId,brand,{subscriber:reader,contact:null},kind,{month:1,day:4,year:2001},'Home anniversary');
  });
  const run=(now:Date)=>planBrand(db,actor.workspaceId,brand,'capture',now);
  await Promise.all([run(day),run(day)]);
  const rows=()=>db.brand(actor.workspaceId,brand,async sql=>(await sql.query("SELECT id,state,local_date::text FROM date_occurrences WHERE kind='anniversary'")).rows);
  expect(await rows()).toMatchObject([{state:'planned',local_date:'2030-01-04'}]);
  await db.brand(actor.workspaceId,brand,sql=>setDate(sql,actor.workspaceId,brand,{subscriber:reader,contact:null},kind,{month:1,day:6},'Home anniversary'));
  await run(new Date('2030-01-05T17:00Z'));
  expect(await rows()).toMatchObject([{state:'planned',local_date:'2030-01-06'}]);
  await dates.execute('dateAutomation.cancel',{id:(await rows())[0]!.id,brandId:brand,operationKey:randomUUID()},actor);
  await run(new Date('2030-01-06T17:00Z'));
  expect(await rows()).toMatchObject([{state:'cancelled'}]);
  await run(new Date('2031-01-05T17:00Z'));
  await run(new Date('2031-01-09T17:00Z'));
  expect((await rows()).map(r=>r.state).sort()).toEqual(['cancelled','expired']);
});

it('walks every brand exactly once across page boundaries',async()=>{
  const {eachDateBrand}=await import('../src/server/date-automations/planner.js');
  await db.tenant(actor.workspaceId,sql=>sql.query(
    "INSERT INTO brands(workspace_id,id,name) SELECT $1,gen_random_uuid(),'Brand '||n FROM generate_series(1,21) n",[actor.workspaceId]));
  const visited:string[]=[];
  await eachDateBrand(db,actor.workspaceId,async id=>{visited.push(id);});
  expect(visited).toHaveLength(22);
  expect(new Set(visited).size).toBe(22);
});

it('checks the live connection and each selected channel grant before recurring activation',async()=>{
  const id=randomUUID(),secret=randomUUID(), target=randomUUID();
  const scopes=['read','automation:manage','sms:send'];
  await db.tenant(actor.workspaceId,async sql=>{
    await sql.query("INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,'Granted brand')",[actor.workspaceId,target]);
    await sql.query(`INSERT INTO connections(workspace_id,id,name,issuer_id,token_hash,scopes,brand_ids,expires_at)
      VALUES($1,$2,'automation fixture',$3,$4,$5,$6,now()+interval '1 day')`,[actor.workspaceId,id,actor.userId,secret,scopes,[target]]);
  });
  const delegated:Actor={...actor,kind:'connection',actorId:'connection:'+id,brandIds:[target],scopes:['read','automation:manage','sms:send']};
  const keys={brandId:target,kind:'anniversary',operationKey:randomUUID()};
  await dates.execute('dateAutomation.save',{...keys,expectedRevision:0,settings:{...settings,email:{subject:'Hello',body:'Happy anniversary!'}}},delegated);
  const activate={...keys,expectedRevision:1,confirmRecurring:true,operationKey:randomUUID()};
  await expect(dates.execute('dateAutomation.activate',activate,delegated)).rejects.toMatchObject({code:'send_scope_required'});
  await db.tenant(actor.workspaceId,sql=>sql.query("UPDATE connections SET scopes=array_append(scopes,'campaign:send') WHERE id=$1",[id]));
  await dates.execute('dateAutomation.activate',activate,delegated);
  await db.tenant(actor.workspaceId,sql=>sql.query('UPDATE connections SET revoked_at=now() WHERE id=$1',[id]));
  await expect(dates.execute('dateAutomation.list',{brandId:target},delegated)).rejects.toMatchObject({code:'automation_access'});
});

it('materializes only greetings due within thirty days across a month boundary', async () => {
  const { planBrand } = await import('../src/server/date-automations/planner.js');
  const { setDate } = await import('../src/server/subscribers/people.js');
  const scopedBrand = randomUUID(), kind = 'anniversary';
  await db.tenant(actor.workspaceId, sql => sql.query(
    'INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [actor.workspaceId, scopedBrand, 'Horizon fixture']));
  const definition = { brandId: scopedBrand, kind };
  await dates.execute('dateAutomation.save', { ...definition, expectedRevision: 0, settings, operationKey: randomUUID() }, actor);
  await dates.execute('dateAutomation.activate', { ...definition, expectedRevision: 1, confirmRecurring: true, operationKey: randomUUID() }, actor);
  const clock = new Date('2032-03-01T15:00:00Z');
  await db.brand(actor.workspaceId, scopedBrand, async sql => {
    await sql.query('UPDATE date_automations SET activated_at=$1,next_scan=$1 WHERE kind=$2', [clock, kind]);
    for (const [month, day] of [[3, 31], [4, 1]] as const) {
      const subscriber = randomUUID();
      await sql.query("INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,'confirmed')",
        [actor.workspaceId, scopedBrand, subscriber, `horizon-${month}@example.test`]);
      await setDate(sql, actor.workspaceId, scopedBrand, { subscriber, contact: null }, kind, { month, day }, 'Membership');
    }
  });
  await planBrand(db, actor.workspaceId, scopedBrand, 'capture', clock);
  const rows = await db.brand(actor.workspaceId, scopedBrand, async sql =>
    (await sql.query('SELECT local_date::text FROM date_occurrences ORDER BY local_date')).rows);
  expect(rows).toEqual([{ local_date: '2032-03-31' }]);
});
