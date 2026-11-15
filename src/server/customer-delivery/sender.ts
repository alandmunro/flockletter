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
export function legalFooter(html: string, text: string, profile: CustomerSenderProfile | null) {
  const legacy = '<p style="font-size:12px;color:#69515d">Preview only. Verified sender details and unsubscribe controls are required before delivery.</p>';
  const body = html.replace(legacy, '');
  if (!profile) return { html: body, text };

  const trialUrl = 'https://flockletter.frostyflamingosoftware.com/';
  const address = profile.organization + ' · ' + profile.postalAddress;
  const consent = 'You are receiving this because you opted in to updates from ' + profile.organization + '.';
  const invitation = (link: string) => 'Are you interested in sending your own newsletters? Visit ' + link + ' to start your free trial.';
  const link = `<a href="${trialUrl}" style="color:#69515d;text-decoration:underline">Flockletter</a>`;
  const paragraph = (line: string) => `<p align="center" style="text-align:center;font-size:12px;color:#69515d">${line}</p>`;
  const footer = [escape(address), escape(consent), invitation(link)].map(paragraph).join('');
  return {
    html: body.replace(/<\/body>/i, closing => footer + closing),
    text: [text, [address, consent, invitation('Flockletter (' + trialUrl + ')')].join('\n')].join('\n\n'),
  };
}
