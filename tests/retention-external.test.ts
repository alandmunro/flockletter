import {generateKeyPairSync,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {expect,it} from 'vitest';
import {disposeExternalCopies} from '../src/server/customer-retention/external-store.js';
import {signExternalInventory,retentionDigest} from '../src/server/customer-retention/approval.js';
import {verifiedExternalInventory} from '../src/server/customer-retention/hosted.js';
import type {ExternalCopyDriver,RetentionApprovalPayload} from '../src/server/customer-retention/hosted-types.js';
it('journals before disposal, reconciles unknown responses, and never blindly submits again',async()=>{
 const key=generateKeyPairSync('ed25519'),privatePem=key.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicPem=key.publicKey.export({type:'spki',format:'pem'}).toString(),now=new Date();
 const scope={databaseName:'flockletter_test',workspaceId:'org_test',jobId:randomUUID(),sourceVersion:'1',manifestDigest:'a'.repeat(64)},copy={id:randomUUID(),store:'media',kind:'s3_object' as const,key:'copy',versionId:'version',digest:'b'.repeat(64)};
 const inventory=verifiedExternalInventory(signExternalInventory({version:1,mode:'live',scope,revision:1,createdAt:now.toISOString(),copies:[copy],exceptions:[]},privatePem,'operator'),{operator:publicPem},scope,'live',now);
 const approval:RetentionApprovalPayload={...scope,version:1,mode:'live',nonce:randomUUID(),operatorId:'user_operator',issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+600000).toISOString(),caseId:randomUUID(),caseVersion:1,inventoryDigest:'c'.repeat(64),checkpoint:{versionId:'v1',digest:'d'.repeat(64),sequence:1},externalInventoryDigest:inventory.digest,exceptionDigest:retentionDigest([])};
 let row:Record<string,unknown>|undefined,submits=0,absent=false;
 const db={query:async(sql:string,args?:unknown[])=>{if(sql.startsWith('INSERT'))row??={state:'pending',target_digest:args![4],approval_digest:args![3]};if(sql.startsWith('SELECT *'))return {rows:[row]};if(sql.includes("state='submitting'"))row!.state='submitting';if(sql.includes("state='complete'"))row!.state='complete';if(sql.includes('SET state=$2'))row!.state=args![1];return {rows:[]};}} as unknown as pg.Client;
 const driver:ExternalCopyDriver={inspect:async()=>absent?'absent':'present',erase:async()=>{expect(row?.state).toBe('submitting');submits++;return 'unknown';}};
 await expect(disposeExternalCopies(db,approval,'e'.repeat(64),inventory,{media:driver},async()=>{})).rejects.toMatchObject({code:'external_reconciliation_required'});expect(row?.state).toBe('unknown');
 await expect(disposeExternalCopies(db,approval,'e'.repeat(64),inventory,{media:driver},async()=>{})).rejects.toMatchObject({code:'external_reconciliation_required'});expect(submits).toBe(1);
 absent=true;await disposeExternalCopies(db,approval,'e'.repeat(64),inventory,{media:driver},async()=>{});expect(row?.state).toBe('complete');expect(submits).toBe(1);
});
