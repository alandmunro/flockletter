import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../../src/server/db.js';
import { lockWorkspace } from '../../src/server/workspace-lock.js';
import { put } from '../../src/server/workspace-gifts/store.js';

// Pre-existing provider receipts and reserved offer. No provider or money commands run.
export async function seedReservedGift(db:Database,w:string,brand:string,person:string,account:string,live:boolean) {
  const now=new Date().toISOString(),expires=new Date(Date.now()+86400000).toISOString();
  const campaign={id:randomUUID(),brand,title:'Thanks',face:500,days:15,created:now,expires,hash:'fixture',
    brokerConfirmed:true,products:['FIXTURE'],live,account};
  const lot={id:randomUUID(),brand,account,live,face:500,fee:50,total:550,created:now,state:'funded' as const,
    reserved:500,spent:0,returned:0,disputed:0,lost:0,disputes:{},paidAt:now,payment:'pi_fixture',charge:'ch_fixture'};
  const offer={id:randomUUID(),campaign:campaign.id,person,brand,face:500,state:'offered' as const,expires,
    alloc:[{id:lot.id,amount:500}],secret:randomBytes(32).toString('hex')};
  await db.brand(w,brand,async sql=>{
    await lockWorkspace(sql,w);
    await put(sql,w,'campaign',campaign.id,campaign);
    await put(sql,w,'lot',lot.id,lot);
    await put(sql,w,'offer',offer.id,offer);
  });
  return {campaign,lot,offer};
}
