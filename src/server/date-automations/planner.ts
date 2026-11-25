import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { lockWorkspace } from '../workspace-lock.js';
import { audit, localParts, nextWindow, readSettings, requireSettings, smsRecipientZones } from '../texting/storage.js';
import { annualOccurrence, recipientZones } from './calendar.js';
import { dateSources, smsRoute, type DateKind, type DateSource } from './sources.js';
import type { DateSettings } from '../../shared/date-automations.js';
import type { AutomationMode } from './service.js';

export type ActiveDefinition = {kind:DateKind;revision:number;settings:DateSettings;activated_at:Date;
  issuer:string;actor:string;mode:AutomationMode;scan_after:string|null;last_scan_started_at:Date|null;current_scan_started_at:Date|null};
const dayMs=86_400_000;
export const monthsOfYear=Array.from({length:12},(_,i)=>i+1);
export const activeDefinitions = `SELECT a.*,r.settings FROM date_automations a JOIN date_automation_revisions r
  USING(workspace_id,brand_id,kind,revision) WHERE enabled`;

// The draft preview and planner must agree on whether this annual receipt can change.
export const replannableOccurrence = `date_occurrences.state='planned' OR date_occurrences.reason IN ('definition_paused','date_changed')`;

export async function annualPolicy(sql:Sql,workspace:string) {
  const settings=await readSettings(sql,workspace);
  return {catchUpDays:requireSettings(settings,['annual_catch_up_days']).annual_catch_up_days,
    smsStart:settings.send_window_start_hour, smsEnd:settings.send_window_end_hour};
}
type Policy=Awaited<ReturnType<typeof annualPolicy>>;
type Window={zones:readonly string[];startHour:number;endHour:number};

function permittedTime(from:Date,expires:Date,windows:Window[]) {
  if(windows.some(w=>w.startHour>=w.endHour)) return null;
  let at=from;
  while(at<expires){
    const next=Math.max(...windows.map(w=>nextWindow(at,w.zones,w.startHour,w.endHour).getTime()));
    if(next===at.getTime()) return at;
    at=new Date(next);
  }
  return null;
}

// A queued greeting keeps its channel. Prior to handoff, both the preview and the worker
// apply SMS hours only to recipients with an eligible SMS route.
export async function schedule(sql:Sql,brand:string,source:DateSource,year:number,settings:DateSettings,policy:Policy,
  lockedChannel?:'sms'|'email'|null) {
  const zones=recipientZones(source.time_zone,source.phone_e164,settings.zone);
  const annual=annualOccurrence(source,year,settings.time,zones.clock,policy.catchUpDays);
  if(!annual) return null;
  const route=lockedChannel==='email'?null:await smsRoute(sql,brand,source);
  const windows:Window[]=[{zones:zones.windows,startHour:settings.startHour,endHour:settings.endHour}];
  let hold:string|null=null;
  if(lockedChannel==='sms'||route){
    if(policy.smsStart===undefined||policy.smsEnd===undefined) hold='texting_setting_required';
    else if(source.phone_e164){
      const carrierZones=await smsRecipientZones(sql,source.time_zone,source.phone_e164);
      if(carrierZones.length===zones.windows.length && carrierZones.every(z=>zones.windows.includes(z))){
        windows[0]={zones:carrierZones,startHour:Math.max(settings.startHour,policy.smsStart),endHour:Math.min(settings.endHour,policy.smsEnd)};
      } else {
        windows.push({zones:carrierZones,startHour:policy.smsStart,endHour:policy.smsEnd});
      }
    }
  }
  const allowed=hold?null:permittedTime(annual.dueAt,annual.expiresAt,windows);
  if(!allowed && !hold) hold='no_permitted_window';
  return {...annual,dueAt:allowed??annual.dueAt,zone:zones.clock,route,hold,windows};
}

async function planPage(sql:Sql, workspace:string,brand:string,def:ActiveDefinition,now:Date,policy:Policy) {
  const horizon=new Date(now.getTime()+30*dayMs);
  // A recipient's local date can fall in the next month or year at the UTC boundary.
  // Keep the start of the previous complete sweep through every page. A restart halfway
  // through a scan must also revisit contacts whose page ran before the outage.
  const lastScan=def.last_scan_started_at??def.activated_at;
  const since=Math.max(def.activated_at.getTime(),Math.min(lastScan.getTime(),now.getTime()-(policy.catchUpDays+1)*dayMs));
  const from=new Date(since-2*dayMs), through=new Date(horizon.getTime()+dayMs);
  const months=new Set<number>();
  for(let t=from.getTime();t<=through.getTime() && months.size<12;t+=dayMs) months.add(new Date(t).getUTCMonth()+1);
  const sources=await dateSources(sql,brand,def.kind,[...months],def.scan_after,100);
  for(const source of sources) for(let year=from.getUTCFullYear();year<=through.getUTCFullYear();year++) {
    const approximate=Date.UTC(year,source.month-1,source.day);
    if(approximate<from.getTime()-dayMs || approximate>through.getTime()+dayMs) continue;
    const when=await schedule(sql,brand,source,year,def.settings,policy);
    if (!when || when.dueAt<def.activated_at || when.dueAt>horizon) continue;
    const expired=when.expiresAt<=now;
    // A retroactively entered or changed date is not evidence of a missed greeting.
    await sql.query(`INSERT INTO date_occurrences(workspace_id,brand_id,id,kind,revision,date_id,annual_year,local_date,due_at,expires_at,zone,state,reason)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13 FROM contact_dates d WHERE d.id=$6
        AND ($12<>'expired' OR d.updated_at<=$9)
      ON CONFLICT(workspace_id,brand_id,kind,date_id,annual_year)
      DO UPDATE SET revision=EXCLUDED.revision,local_date=EXCLUDED.local_date,due_at=EXCLUDED.due_at,
        expires_at=EXCLUDED.expires_at,zone=EXCLUDED.zone,state=EXCLUDED.state,reason=EXCLUDED.reason
      WHERE ${replannableOccurrence}`,
    [workspace,brand,randomUUID(),def.kind,def.revision,source.id,year,when.localDate,when.dueAt,when.expiresAt,when.zone,
      expired?'expired':'planned',expired?'catch_up_window_closed':when.hold]);
  }
  const more=sources.length===100;
  const sweepStart=def.current_scan_started_at??now;
  await sql.query(`UPDATE date_automations SET scan_after=$2,next_scan=$3,
    last_scan_started_at=CASE WHEN $4 THEN last_scan_started_at ELSE $5 END,
    current_scan_started_at=CASE WHEN $4 THEN $5 ELSE NULL END WHERE kind=$1`,
    [def.kind,more?sources.at(-1)!.id:null,new Date(now.getTime()+(more?0:60_000)),more,sweepStart]);
}

export async function planBrand(db:Database,workspace:string,brand:string,mode:AutomationMode,now:Date) {
  if (mode==='off') return;
  await db.brand(workspace,brand,async sql=>{
    await lockWorkspace(sql,workspace);
    // Only a channel worker can establish that a queued intent never reached a provider.
    // A changed date or revision may be planned again once that negative receipt exists.
    const withdrawn=(await sql.query<{id:string;delivery_id:string;channel:string}>(`SELECT o.id,o.delivery_id,o.channel
      FROM date_occurrences o LEFT JOIN sms_messages m ON o.channel='sms' AND m.id=o.delivery_id AND m.date_brand_id=o.brand_id
      LEFT JOIN customer_delivery_recipients p ON o.channel='email' AND p.delivery_id=o.delivery_id AND p.brand_id=o.brand_id
      WHERE o.state='queued' AND ((m.state='skipped' AND m.submitted_at IS NULL AND m.reason IN ('date_changed','definition_changed')) OR
        (p.state='cancelled' AND p.attempts=0 AND p.reason IN ('date_changed','definition_changed')))
      ORDER BY o.id LIMIT 100`)).rows;
    for(const row of withdrawn){
      await audit(sql,workspace,'worker','worker','automation.withdrawn',row.id,{channel:row.channel,deliveryId:row.delivery_id},{reason:'changed_before_submission'});
      await sql.query(`UPDATE date_occurrences SET state='skipped',reason='date_changed',channel=NULL,delivery_id=NULL,
        source_digest=NULL,dispatched_contact=NULL,retry_at=NULL WHERE id=$1`,[row.id]);
    }
    const policy=await annualPolicy(sql,workspace);
    // Apply policy edits to outstanding plans, including rows outside this scan page.
    const cutoff="((local_date+($2::int+1))::timestamp AT TIME ZONE zone)";
    await sql.query(`UPDATE date_occurrences SET expires_at=${cutoff},
      state=CASE WHEN ${cutoff}<=$1 THEN 'expired' ELSE state END,
      reason=CASE WHEN ${cutoff}<=$1 THEN 'catch_up_window_closed' ELSE reason END
      WHERE state='planned' AND (expires_at IS DISTINCT FROM ${cutoff} OR ${cutoff}<=$1)`,[now,policy.catchUpDays]);
    // Edits outside the scanned months and clears must also disappear from upcoming previews.
    await sql.query(`UPDATE date_occurrences o SET state='skipped',reason='date_changed' WHERE state='planned'
      AND NOT EXISTS(SELECT FROM contact_dates d WHERE d.brand_id=o.brand_id AND d.id=o.date_id AND d.cleared_at IS NULL
        AND d.month=extract(month FROM o.local_date) AND (d.day=extract(day FROM o.local_date) OR
          (d.month=2 AND d.day=29 AND extract(day FROM o.local_date)=28)))`);
    const defs=(await sql.query<ActiveDefinition>(activeDefinitions+' AND mode=$1 AND next_scan<=$2 ORDER BY kind',[mode,now])).rows;
    for(const def of defs) await planPage(sql,workspace,brand,def,now,policy);
  });
}

// Brand discovery walks the whole workspace in key order, separately from the maintenance top-five.
// Each transaction releases the workspace lock before the next page or brand is visited.
export async function eachDateBrand(db:Database,workspace:string,visit:(brand:string)=>Promise<void>) {
  let after:string|null=null;
  for (;;) {
    const brands:string[]=await db.read(workspace,async sql=>(await sql.query<{id:string}>(
      'SELECT id FROM brands WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 20',[after])).rows.map(b=>b.id));
    for(const brand of brands) await visit(brand);
    if(brands.length<20) return;
    after=brands.at(-1)!;
  }
}

export function insideWindow(now:Date,windows:Window[]) {
  return windows.every(w=>w.zones.every(zone=>{
    const hour=localParts(now,zone).hour;
    return hour>=w.startHour&&hour<w.endHour;
  }));
}
