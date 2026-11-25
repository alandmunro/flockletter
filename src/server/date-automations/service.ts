import { schedule } from './planner.js';
import { productionConsentEligible } from '../customer-audience/service.js';
import { dateSources,smsRoute } from './sources.js';
import { renderGreeting } from '../../shared/date-automations.js';
import type { Actor } from '../service.js';
import type { Database, Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { lockWorkspace } from '../workspace-lock.js';
import { audit, brandScope } from '../customer-delivery/storage.js';
import { once } from '../texting/storage.js';
import { dateCommands, type DateCommand, type DateSettings } from '../../shared/date-automations.js';

export type AutomationMode = 'off'|'capture'|'live';
export async function authorized(sql: Sql, workspace:string, brand:string, issuer:string, actor:string,
  isOwner:(user:string,workspace:string)=>Promise<boolean>, settings?:DateSettings) {
  if (!await isOwner(issuer,workspace)) return false;
  if (actor==='user:'+issuer) return true;
  if (!actor.startsWith('connection:')) return false;
  const scopes=['read','automation:manage'];
  if (settings) scopes.push('sms:send', ...(settings.email ? ['campaign:send'] : []));
  return Boolean((await sql.query(`SELECT FROM connections WHERE id::text=$1 AND issuer_id=$2 AND revoked_at IS NULL
    AND expires_at>clock_timestamp() AND $3::uuid=ANY(brand_ids) AND scopes @> $4::text[]`,
  [actor.slice(11),issuer,brand,scopes])).rowCount);
}
export class DateAutomations {
  constructor(readonly db:Database,readonly mode:AutomationMode,readonly isOwner:(user:string,workspace:string)=>Promise<boolean>) {}
  async execute(name:DateCommand, raw:unknown, actor:Actor) {
    const input=dateCommands[name].schema.parse(raw), workspace=actor.workspaceId, brand=input.brandId;
    return this.db.brand(workspace,brand,async sql=>{
      await lockWorkspace(sql,workspace);
      await brandScope(sql,actor,brand);
      requireCondition(await authorized(sql,workspace,brand,actor.userId,actor.actorId,this.isOwner),403,'automation_access','Current automation access is required.');
      if(name==='dateAutomation.preview'){
        const p=dateCommands[name].schema.parse(raw);
        const now=new Date(),end=new Date(now.getTime()+30*86400000);
        const months=new Set([now.getUTCMonth()+1,end.getUTCMonth()+1,new Date(now.getTime()-86400000).getUTCMonth()+1,new Date(end.getTime()+86400000).getUTCMonth()+1]);
        months.add(new Date(now.getTime()+15*86400000).getUTCMonth()+1);
        const sources=await dateSources(sql,brand,p.kind,[...months],p.cursor,100);
        const rows=[];
        for(const source of sources)for(let year=now.getUTCFullYear()-1;year<=end.getUTCFullYear()+1;year++){
          const when=schedule(source,year,p.settings);
          if(!when||when.dueAt<now||when.dueAt>end)continue;
          const sms=await smsRoute(sql,brand,source);
          const email=p.settings.email&&source.subscriber_id&&source.email_state==='confirmed'
            &&(this.mode!=='live'||await productionConsentEligible(sql,source.subscriber_id));
          const template=sms?p.settings.sms:email?p.settings.email!.body:null;
          rows.push({id:source.id,recipient:source.first_name??source.email??(source.phone_e164?'Phone ending '+source.phone_e164.slice(-4):'Unnamed contact'),
            dueAt:when.dueAt,zone:when.zone,channel:sms?'SMS':email?'Email':'No eligible channel',
            message:template?renderGreeting(template,source.first_name,source.label,when.years):null});
        }
        return {rows:rows.sort((a,b)=>a.dueAt.getTime()-b.dueAt.getTime()),next:sources.length===100?sources.at(-1)!.id:null};
      }
      if(name==='dateAutomation.list') return {mode:this.mode, definitions:(await sql.query(
        'SELECT kind,revision,enabled,settings FROM date_automations JOIN date_automation_revisions USING(workspace_id,brand_id,kind,revision) ORDER BY kind')).rows};
      if (name==='dateAutomation.occurrences') {
        const input=dateCommands[name].schema.parse(raw);
        return {rows:(await sql.query(`SELECT o.id,o.kind,o.local_date::text,o.due_at,o.zone,o.state,o.reason,o.channel,o.date_id,
          coalesce(s.email_normalized,CASE WHEN c.id IS NOT NULL THEN 'Phone ending '||right(c.phone_e164,4) END) recipient,
          NULL::text delivery_state FROM date_occurrences o LEFT JOIN contact_dates d ON d.id=o.date_id AND d.brand_id=o.brand_id
          LEFT JOIN subscribers s ON s.id=d.subscriber_id AND s.brand_id=o.brand_id LEFT JOIN sms_contacts c ON c.id=d.contact_id
          WHERE CASE WHEN $1='upcoming' THEN o.state='planned' AND o.due_at<clock_timestamp()+interval '30 days'
            ELSE o.state<>'planned' END ORDER BY CASE WHEN $1='upcoming' THEN o.due_at END,o.due_at DESC,o.id LIMIT 51 OFFSET $2`,[input.view,input.offset])).rows};
      }
      const mutation=dateCommands[name].schema.parse(raw);
      return once(sql,workspace,actor.actorId,mutation.operationKey,[name,mutation],async()=>{
        if (name==='dateAutomation.cancel') {
          const input=dateCommands[name].schema.parse(raw);
          const changed=await sql.query("UPDATE date_occurrences SET state='cancelled',reason='owner_cancelled' WHERE id=$1 AND state IN ('planned','cancelled')",[input.id]);
          requireCondition(changed.rowCount,409,'cannot_cancel','The occurrence has already been processed or is unavailable.');
          await audit(sql,actor,name,input.id);
          return {id:input.id,state:'cancelled'};
        }
        const input=dateCommands[name].schema.parse(raw);
        const current=(await sql.query<{revision:number;enabled:boolean;settings:DateSettings}>(`SELECT revision,enabled,settings
          FROM date_automations JOIN date_automation_revisions USING(workspace_id,brand_id,kind,revision) WHERE kind=$1`,[input.kind])).rows[0];
        requireCondition((current?.revision??0)===input.expectedRevision,409,'version_conflict','Reload the current revision.');
        if (name==='dateAutomation.save') {
          const input=dateCommands[name].schema.parse(raw);
          const revision=input.expectedRevision+1;
          await sql.query(`INSERT INTO date_automations(workspace_id,brand_id,kind,revision) VALUES($1,$2,$3,$4)
            ON CONFLICT(workspace_id,brand_id,kind) DO UPDATE SET revision=EXCLUDED.revision,enabled=false,scan_after=NULL,next_scan=now()`,
          [workspace,brand,input.kind,revision]);
          await sql.query('INSERT INTO date_automation_revisions(workspace_id,brand_id,kind,revision,settings) VALUES($1,$2,$3,$4,$5)',[workspace,brand,input.kind,revision,input.settings]);
        } else {
          requireCondition(current,404,'draft_required','Save a draft first.');
          if (name==='dateAutomation.activate') {
            requireCondition(this.mode!=='off',409,'automation_off','Recurring delivery is disabled in this environment.');
            requireCondition(await authorized(sql,workspace,brand,actor.userId,actor.actorId,this.isOwner,current.settings),403,'send_scope_required','Grant the selected marketing channels.');
            if (!current.enabled) await sql.query(`UPDATE date_automations SET enabled=true,issuer=$2,actor=$3,mode=$4,
              activated_at=clock_timestamp(),scan_after=NULL,next_scan=now() WHERE kind=$1`,[input.kind,actor.userId,actor.actorId,this.mode]);
          } else await sql.query('UPDATE date_automations SET enabled=false WHERE kind=$1',[input.kind]);
        }
        if (name!=='dateAutomation.activate') await sql.query("UPDATE date_occurrences SET state='skipped',reason='definition_paused' WHERE kind=$1 AND state='planned'",[input.kind]);
        await audit(sql,actor,name,brand);
        return {kind:input.kind,revision:name==='dateAutomation.save'?input.expectedRevision+1:input.expectedRevision};
      });
    });
  }
}
