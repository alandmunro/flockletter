import { renderGreeting, type DateSettings } from '../../shared/date-automations.js';
import { blockedCharacters, composeBroadcast, encodeText, maxSegments } from '../../shared/texting.js';
import { digest } from '../content.js';
import type { Database,Sql } from '../db.js';
import { AppError,requireCondition } from '../errors.js';
import { lockWorkspace } from '../workspace-lock.js';
import type { CustomerDelivery } from '../customer-delivery/service.js';
import type { Texting } from '../texting/service.js';
import { businessName, queueText } from '../texting/messaging.js';
import { coversTextCompany } from '../texting/company-access.js';
import { authorized, type AutomationMode } from './service.js';
import { dateSources, type DateSource, type DateKind } from './sources.js';
import { insideWindow, monthsOfYear, schedule } from './planner.js';
import { recipientZones } from './calendar.js';
import type { Actor } from '../service.js';

type Occurrence = {id:string;activated_at:Date;date_id:string;kind:DateKind;annual_year:number;zone:string;state:string;
  local_date:string;due_at:Date;expires_at:Date;revision:number;active_revision:number;enabled:boolean;
  settings:DateSettings;issuer:string;actor:string;mode:AutomationMode;mailing_id:string;source_digest:string|null};
const joinOccurrence=`SELECT o.*,o.local_date::text,a.enabled,a.activated_at,a.revision active_revision,a.issuer,a.actor,a.mode,r.settings,r.mailing_id
 FROM date_occurrences o JOIN date_automations a USING(workspace_id,brand_id,kind)
 JOIN date_automation_revisions r ON (r.workspace_id,r.brand_id,r.kind,r.revision)=(o.workspace_id,o.brand_id,o.kind,o.revision)`;
type Ports={texting?:Texting|undefined;delivery:CustomerDelivery;mode:AutomationMode;isOwner:(user:string,workspace:string)=>Promise<boolean>};

async function inspect(sql:Sql,w:string,b:string,o:Occurrence,ports:Ports,now:Date) {
  requireCondition(o.enabled&&o.revision===o.active_revision&&o.mode===ports.mode&&ports.mode!=='off',409,'definition_changed','Automation approval changed.');
  requireCondition(o.due_at>=o.activated_at,409,'definition_changed','The date predates the current activation.');
  requireCondition(now<o.expires_at,409,'expired','Catch-up window closed.');
  let permitted:boolean;
  try { permitted=await authorized(sql,w,b,o.issuer,o.actor,ports.isOwner,o.settings); }
  catch { throw new AppError(503,'authority_verification_unavailable','Current send authority could not be verified.'); }
  requireCondition(permitted,403,'authority_revoked','Send authority changed.');
  if (ports.delivery.options.eligibilitySql) {
    const account=await ports.delivery.options.eligibilitySql(sql,w);
    requireCondition(account.eligible,409,'subscription_ineligible','The workspace cannot send marketing messages.');
  }
  const source=(await dateSources(sql,b,o.kind,monthsOfYear,null,1,o.date_id))[0];
  requireCondition(source,409,'date_changed','Date removed or changed.');
  const when=schedule(source,o.annual_year,o.settings);
  requireCondition(when&&when.localDate===o.local_date&&when.dueAt.getTime()===o.due_at.getTime(),409,'date_changed','Date or time changed.');
  const zones=recipientZones(source.time_zone,source.phone_e164,o.settings.zone);
  requireCondition(now>=when.dueAt&&insideWindow(now,zones.windows,o.settings),409,'outside_window','Waiting for the recipient window.');
  return {source,when,signature:digest(JSON.stringify([source,when.years]))};
}
async function smsRoute(sql:Sql,brand:string,s:DateSource) {
  if (!s.contact_id || s.shared_phone) return null;
  return (await sql.query<{company_id:string}>(`SELECT cb.company_id FROM company_brands cb JOIN sms_consents x USING(workspace_id,company_id)
    JOIN sms_contacts c ON c.id=x.contact_id WHERE cb.brand_id=$1 AND c.id=$2 AND c.textable AND x.state='opted_in'`,[brand,s.contact_id])).rows[0]??null;
}
async function checkCompany(sql:Sql,company:string,actor:string) {
  if (!actor.startsWith('connection:')) return;
  const grant=(await sql.query<{brand_ids:string[]}>('SELECT brand_ids FROM connections WHERE id::text=$1',[actor.slice(11)])).rows[0];
  requireCondition(grant&&await coversTextCompany(sql,company,grant.brand_ids),403,'authority_revoked','The connection must cover the sending company.');
}

// Called inside the existing marketing worker's claim, after the brand boundary is set.
// Returning a reason prevents a new submission. Reconciliation bypasses this function.
export async function annualClaim(sql:Sql,workspace:string,brand:string,channel:'sms'|'email',deliveryId:string,
  ports:Ports,now:Date,company?:string) {
  const o=(await sql.query<Occurrence>(joinOccurrence+' WHERE o.channel=$1 AND o.delivery_id=$2',[channel,deliveryId])).rows[0];
  if (!o||o.state!=='queued') return 'occurrence_cancelled';
  try {
    const {source,signature}=await inspect(sql,workspace,brand,o,ports,now);
    if(signature!==o.source_digest) return 'date_changed';
    if(channel==='sms'){
      const current=await smsRoute(sql,brand,source);
      if(!current||current.company_id!==company) return 'no_consent';
      await checkCompany(sql,current.company_id,o.actor);
      if(ports.texting?.options.mode!==(ports.mode==='capture'?'mock':'live'))return 'delivery_configuration_changed';
    } else if ((ports.delivery.options.mode==='capture')!==(ports.mode==='capture'))return 'delivery_configuration_changed';
    return null;
  } catch(error) {if(error instanceof AppError)return error.code;throw error;}
}

async function handoff(sql:Sql,w:string,b:string,o:Occurrence,ports:Ports,now:Date) {
  const {source,when,signature}=await inspect(sql,w,b,o,ports,now);
  const render=(s:string)=>renderGreeting(s,source.first_name,source.label,when.years);
  const route=await smsRoute(sql,b,source);
  const channel=route?'sms':'email';
  let id:string;
  if(route){
    requireCondition(ports.texting?.options.mode===(ports.mode==='capture'?'mock':'live'),409,'transport_unavailable','The selected SMS transport is unavailable.');
    await checkCompany(sql,route.company_id,o.actor);
    const body=composeBroadcast(render(o.settings.sms),await businessName(sql,route.company_id),{name:source.first_name});
    const links=await ports.texting.linkProblems(sql,route.company_id,body);
    await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[b]);
    requireCondition(!blockedCharacters(body).length&&!links.problems.length&&encodeText(body).segments<=maxSegments,422,'invalid_message','Rendered text failed the marketing content checks.');
    const prior=await sql.query(`SELECT FROM date_occurrences WHERE dispatched_contact=$1 AND kind=$2 AND annual_year=$3
      AND delivery_id IS NOT NULL AND channel='sms' LIMIT 1`,[source.contact_id,o.kind,o.annual_year]);
    requireCondition(!prior.rowCount,409,'shared_annual_destination','This phone already has an annual greeting.');
    id=await queueText(sql,w,{companyId:route.company_id,contactId:source.contact_id,to:source.phone_e164!,purpose:'broadcast',body});
    await sql.query('UPDATE sms_messages SET date_brand_id=$2 WHERE id=$1',[id,b]);
  } else {
    requireCondition(source.subscriber_id&&o.settings.email,409,'no_eligible_channel','No authorized fallback.');
    const mode=ports.delivery.options.mode;
    requireCondition(mode!=='off'&&(mode==='capture')===(ports.mode==='capture'),409,'transport_unavailable','The selected email transport is unavailable.');
    const actor:Actor={workspaceId:w,userId:o.issuer,actorId:o.actor,owner:true,kind:o.actor.startsWith('connection:')?'connection':'session',brandIds:[b],scopes:['read','campaign:send']};
    id=await ports.delivery.queueAnnualEmail(sql,actor,b,o.mailing_id,source.subscriber_id,render(o.settings.email.subject),render(o.settings.email.body),o.kind==='birthday'?'Birthday greeting':'Anniversary greeting');
  }
  await sql.query(`UPDATE date_occurrences SET state='queued',reason=NULL,channel=$2,delivery_id=$3,source_digest=$4,dispatched_contact=$5 WHERE id=$1`,
    [o.id,channel,id,signature,source.contact_id]);
}

export async function dispatchBrand(db:Database,w:string,b:string,ports:Ports,now:Date) {
  if(ports.mode==='off')return;
  await db.brand(w,b,async sql=>{
    await lockWorkspace(sql,w);
    const rows=(await sql.query<Occurrence>(joinOccurrence+` WHERE o.state='planned' AND o.due_at<=$1 AND
      (o.retry_at IS NULL OR o.retry_at<=$1) ORDER BY o.due_at,o.id LIMIT 10`,[now])).rows;
    for(const o of rows){
      await sql.query('SAVEPOINT annual_dispatch');
      try {await handoff(sql,w,b,o,ports,now);}
      catch(error){
        await sql.query('ROLLBACK TO SAVEPOINT annual_dispatch');
        if(!(error instanceof AppError))throw error;
        const terminal=['authority_revoked','date_changed','definition_changed','no_eligible_channel','audience_empty','invalid_message','shared_annual_destination','expired'].includes(error.code);
        await sql.query('UPDATE date_occurrences SET state=$2,reason=$3,retry_at=$4 WHERE id=$1',
          [o.id,terminal?'skipped':'planned',error.code,new Date(now.getTime()+60_000)]);
      }
      await sql.query('RELEASE SAVEPOINT annual_dispatch');
    }
  });
}
