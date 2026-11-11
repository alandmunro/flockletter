import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import pg from 'pg';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import {OperatorStore} from '../src/server/platform/store.js';
import {operatorRoleGrants} from '../src/server/platform/provision.js';

it('keeps overlapping operator web processes inside the two-connection role limit',async()=>{
 const fixture=await startDatabase(),root=new pg.Client({connectionString:fixture.adminUrl}),runtime=new Database(fixture.url,1);
 const stores:OperatorStore[]=[],transactions:Promise<unknown>[]=[],reads:Promise<unknown>[]= [];
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),bothEntered=new Promise<void>(resolve=>{entered=resolve;});
 let count=0;
 try{
  await root.connect();
  const role='flockletter_pool_operator',password=randomUUID();
  await root.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD ${pg.escapeLiteral(password)}`);
  await root.query(operatorRoleGrants('flockletter_test',role));
  const url=new URL(fixture.url);url.username=role;url.password=password;
  stores.push(new OperatorStore(runtime,'live',url.href),new OperatorStore(runtime,'live',url.href));
  for(const store of stores)await store.verify();
  for(const [i,store] of stores.entries()){
   const task=store.transaction('org_pool_'+i,async records=>{
    await records.put('health','current',{instance:i});
    if(++count===2)entered();
    await gate;
   });
   void task.catch(()=>{});transactions.push(task);
  }
  const allTransactions=Promise.all(transactions);
  void allTransactions.catch(()=>{});
  await Promise.race([bothEntered,allTransactions.then(()=>{throw Error('Transactions ended before the gate.');})]);
  expect(Number((await root.query('SELECT count(*) n FROM pg_stat_activity WHERE usename=$1',[role])).rows[0].n)).toBe(2);
  let completedWhileHeld=false;
  for(const [i,store] of stores.entries()){
   const task=store.read('health','org_pool_'+i).then(value=>{completedWhileHeld=true;return value;},error=>{completedWhileHeld=true;throw error;});
   void task.catch(()=>{});reads.push(task);
  }
  await new Promise(resolve=>setTimeout(resolve,250));
  expect(completedWhileHeld).toBe(false);
  release();await allTransactions;
  expect(await Promise.all(reads)).toEqual([[{instance:0}],[{instance:1}]]);
 }finally{
  release();await Promise.allSettled([...transactions,...reads]);
  await Promise.allSettled(stores.map(store=>store.close()));
  await runtime.close();await root.end();await fixture.stop();
 }
});
