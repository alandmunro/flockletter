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
