import type { Sql } from '../db.js';
import { digest } from '../content.js';
import type { CustomerSenderProfile } from '../../shared/customer-delivery.js';
import type { CustomerProvider } from './types.js';
import type { Database } from '../db.js';
import { lookupTxt,verifySender,type LookupTxt } from '../campaign/sender.js';
import { locked } from './storage.js';

export async function senderProfile(sql:Sql,brand:string):Promise<CustomerSenderProfile|null> {
  const row=(await sql.query<{profile:CustomerSenderProfile}>('SELECT profile FROM customer_sender_profiles WHERE brand_id=$1',[brand])).rows[0];
  return row?.profile??null;
}
export function senderFingerprint(provider:CustomerProvider|undefined,profile:CustomerSenderProfile|null) {
  return (provider?.fingerprint??'customer-capture-v1')+(profile?':'+profileFingerprint(profile):'');
}
export function profileFingerprint(profile:CustomerSenderProfile|null) {
  return profile?digest(JSON.stringify([profile.fromName,profile.fromEmail,profile.replyTo,profile.organization,profile.postalAddress,profile.revision])):null;
}
export async function senderEligible(sql:Sql,brand:string,provider:CustomerProvider|undefined) {
  const profile=await senderProfile(sql,brand);
  if(!profile||!provider||provider.from!==profile.fromEmail)return false;
  const domain=profile.fromEmail.split('@')[1]!;
  if(!(await sql.query("SELECT FROM sender_domains WHERE domain=$1 AND verified_at>clock_timestamp()-interval '24 hours'",[domain])).rowCount)return false;
  return (await provider.ready?.())===true;
}
export async function refreshCustomerSender(db:Database,workspace:string,brand:string,lookup:LookupTxt=lookupTxt) {
  return locked(db,workspace,async sql=>{
    await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[brand]);
    const due=(await sql.query("SELECT FROM sender_domains WHERE checked_at IS NULL OR checked_at<clock_timestamp()-interval '12 hours'")).rowCount;
    return due?verifySender(sql,lookup):null;
  });
}
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function legalFooter(html:string,text:string,profile:CustomerSenderProfile|null) {
  const legacy='<p style="font-size:12px;color:#69515d">Preview only. Verified sender details and unsubscribe controls are required before delivery.</p>';
  const footer=profile?'<p style="font-size:12px;color:#69515d">'+escape(profile.organization)+' · '+escape(profile.postalAddress)+'</p><p style="font-size:12px;color:#69515d">You are receiving this because you opted in to updates from '+escape(profile.organization)+'.</p>':'';
  return {html:html.replace(legacy,'').replace(/<\/body>/i,footer+'</body>'),text:text+(profile?'\n\n'+profile.organization+' · '+profile.postalAddress+'\nYou are receiving this because you opted in to updates from '+profile.organization+'.':'')};
}
