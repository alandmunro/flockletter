import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import type {CustomerDeliveryStatus} from '../src/shared/customer-delivery.js';
import {createMcpServer} from '../src/mcp/bridge.js';
import {createTestSendFixture} from './helpers/test-send-fixture.js';
import {saveSenderProfile} from './helpers/delivery-profile.js';
import {makeAudienceConnection} from './helpers/audience-connection.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database;
beforeAll(async()=>{fixture=await startDatabase();db=new Database(fixture.url);});
afterAll(async()=>{await db?.close();await fixture?.stop();});

it('reports missing selected-provider binding, then recovers sender readiness without submitting mail',async()=>{
 const f=await createTestSendFixture(db,{mode:'resend',scope:'tests'});
 const status=()=>f.delivery.execute('delivery.status',{brandId:f.brandId},f.actor) as Promise<CustomerDeliveryStatus>;
 const missing=await status();expect(missing.providerConfigured).toBe(false);expect(missing.senderVerified).toBe(false);
 expect(missing.gaps.join(' ')).toContain('No Resend route');expect(missing.gaps.join(' ')).not.toContain('AWS');
 expect(missing.context).toMatchObject({workspaceId:f.workspaceId,environment:'test'});
 expect(missing.broadcastsEnabled).toBe(false);expect(missing.testSendingEnabled).toBe(true);
 let ready=false;const submit=vi.fn(async()=>({outcome:'not_submitted' as const}));
 f.options.provider=()=>({fingerprint:'synthetic-resend-route',from:'news@shop.test',ready:async()=>ready,submit,lookup:async()=>({outcome:'unknown'})});
 await saveSenderProfile(f.delivery,f.actor,f.brandId);
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query("INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,verified_at) VALUES($1,$2,'shop.test',gen_random_uuid(),clock_timestamp())",[f.workspaceId,f.brandId]));
 expect((await status()).gaps.join(' ')).toContain('Resend readiness');
 ready=true;const recovered=await status();expect(recovered.gaps).toEqual([]);expect(recovered.providerConfigured).toBe(true);expect(recovered.senderVerified).toBe(true);
 f.options.render=undefined;expect((await status()).gaps.join(' ')).toContain('renderer is unavailable');
 expect(submit).not.toHaveBeenCalled();
 expect((await db.tenant(f.workspaceId,sql=>sql.query('SELECT count(*)::int n FROM customer_deliveries'))).rows[0]?.n).toBe(0);
});

it('returns current context over MCP and refuses foreign-brand diagnostics',async()=>{
 const f=await createTestSendFixture(db,{scope:'tests'}),other=await createTestSendFixture(db,{scope:'tests'});
 const connection=await makeAudienceConnection(db,f.actor,[f.brandId],['read','campaign:send']);
 const server=createMcpServer((name,input)=>f.delivery.execute(name,input,connection.actor));
 const client=new Client({name:'synthetic-diagnostics',version:'1'});const [c,s]=InMemoryTransport.createLinkedPair();
 await server.connect(s);await client.connect(c);
 try{
  const result=await client.callTool({name:'delivery_status',arguments:{brandId:f.brandId}});
  const value=(result.content as {type:string;text:string}[]).find(item=>item.type==='text')!;
  expect(JSON.parse(value.text).context).toMatchObject({workspaceId:f.workspaceId,environment:'test'});
  await expect(f.delivery.execute('delivery.status',{brandId:other.brandId},f.actor)).rejects.toMatchObject({status:404});
 }finally{await client.close();await server.close();}
});

it('explains a missing saved campaign without creating a review or substituting a current draft',async()=>{
 const f=await createTestSendFixture(db,{scope:'tests'});
 await expect(f.delivery.execute('delivery.preflight',{brandId:f.brandId,campaignId:randomUUID(),expectedVersion:6,purpose:'test',subscriberId:f.subscriberId},f.actor)).rejects.toMatchObject({status:404,code:'campaign_unavailable'});
 expect((await db.tenant(f.workspaceId,sql=>sql.query('SELECT count(*)::int n FROM customer_deliveries'))).rows[0]?.n).toBe(0);
});
