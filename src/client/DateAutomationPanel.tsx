import { useEffect,useRef,useState } from 'react';
import { dateSettings, giftGreetingBody, giftGreetingSubject, renderGreeting,type DateDefinition,type DateKind,type DateOccurrence,type DateSettings } from '../shared/date-automations.js';
import { operationKey,type Api } from './api.js';

type Props={api:Api;brandId:string};
type LegacyDate={id:string;label:string;month:number;day:number;ending:string;version:string};
type Catalog={mode:string;giftDeliveryEnabled:boolean;unattributed:LegacyDate[];definitions:DateDefinition[];health:{oldest_due:string|null;uncertain:number;skipped:number}};
type Preview={rows:{id:string;recipient:string;dueAt:string;zone:string;hold?:string|null;channel:string;message:string|null}[];next:string|null};
const title=(kind:DateKind)=>kind==='birthday'?'Birthday':'Anniversary';
const defaults=(kind:DateKind):DateSettings=>({time:'10:00',zone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',startHour:9,endHour:20,
  sms:kind==='birthday'?'Happy birthday, {{firstName}}!':'Happy {{label}}, {{firstName}}!',email:null});
const local=(instant:string,zone:string)=>new Intl.DateTimeFormat(undefined,{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(instant));
const explain=(e:unknown)=>e instanceof Error?e.message:'Could not load the automation.';

export function DateAutomationPanel(props:Props) {
  const [open,setOpen]=useState(false);
  return <details className="card date-controls" onToggle={e=>setOpen(e.currentTarget.open)}><summary>Birthday and anniversary automations</summary>
    {open&&<AutomationControls {...props}/>}</details>;
}

function AutomationControls({api,brandId}:Props) {
  const [data,setData]=useState<Catalog>(),[error,setError]=useState(''),[kind,setKind]=useState<DateKind>('birthday'),[refresh,setRefresh]=useState(0);
  useEffect(()=>{let active=true;
    api.call<Catalog>('dateAutomation.list',{brandId}).then(v=>{if(active){setData(v);setError('');}}).catch(e=>{if(active)setError(explain(e));});
    return ()=>{active=false;};
  },[api,brandId,refresh]);
  const def=data?.definitions.find(d=>d.kind===kind);
  return <section aria-label="Annual greetings"><h2>Annual greetings</h2>
    {error&&<p role="alert">{error} <button onClick={()=>setRefresh(v=>v+1)}>Retry</button></p>}
    {data?.unattributed.length ? <section><h3>Dates needing brand confirmation</h3><p>These phone dates predate brand tracking. Confirm only dates collected for this brand.</p><ul>{data.unattributed.map(d=><li key={d.id}>Phone ending {d.ending} · {d.label} · {d.month}/{d.day} <button onClick={async()=>{
      try{await api.call('dateAutomation.attribute',{brandId,id:d.id,expectedUpdate:d.version,operationKey:operationKey()});setRefresh(v=>v+1);}catch(e){setError(explain(e));}
    }}>Confirm source brand</button></li>)}</ul></section>:null}
    {data?<><label>Greeting <select value={kind} onChange={e=>setKind(e.target.value as DateKind)}><option value="birthday">Birthday</option><option value="anniversary">Anniversary</option></select></label>
      <Editor key={kind+'-'+def?.revision+'-'+def?.enabled} api={api} brandId={brandId} kind={kind} def={def} mode={data.mode} giftDeliveryEnabled={data.giftDeliveryEnabled} changed={()=>setRefresh(v=>v+1)}/>
      <History api={api} brandId={brandId} refresh={refresh} changed={()=>setRefresh(v=>v+1)}/>
      <p>{data.health.uncertain} awaiting provider reconciliation · {data.health.skipped} skipped or expired{data.health.oldest_due?' · Oldest due '+new Date(data.health.oldest_due).toLocaleString():''}</p></>:!error&&<p role="status">Loading annual greetings…</p>}
  </section>;
}

function Editor({api,brandId,kind,def,mode,giftDeliveryEnabled,changed}:Props&{kind:DateKind;def:DateDefinition|undefined;mode:string;giftDeliveryEnabled:boolean;changed:()=>void}) {
  const [settings,setSettings]=useState<DateSettings>(def?.settings??defaults(kind)),[busy,setBusy]=useState(false),[error,setError]=useState(''),
    [review,setReview]=useState(false),[preview,setPreview]=useState<Preview>();
  const retry=useRef<{signature:string;key:string}|null>(null);
  const dirty=JSON.stringify(settings)!==JSON.stringify(def?.settings);
  const edit=(v:Partial<DateSettings>)=>{setSettings(s=>({...s,...v}));setPreview(undefined);setReview(false);setError('');};
  async function action(name:'save'|'activate'|'pause'|'preview',cursor:string|null=null) {
    setBusy(true);setError('');
    try{
      if(name==='preview'||name==='save'){
        const validation=dateSettings.safeParse(settings);
        if(!validation.success)throw Error(validation.error.issues.map(v=>v.path.join('.')+' '+v.message).join('. '));
      }
      if(name==='preview'){
        const page=await api.call<Preview>('dateAutomation.preview',{brandId,kind,settings,cursor});
        setPreview(old=>cursor&&old?{rows:[...old.rows,...page.rows],next:page.next}:page);
      }else{
        const payload={brandId,kind,expectedRevision:def?.revision??0,...(name==='save'?{settings}:{}),...(name==='activate'?{confirmRecurring:true,...(settings.giftCampaignId?{giftMode:mode}:{})}:{})};
        const signature=JSON.stringify([name,payload]);
        if(retry.current?.signature!==signature)retry.current={signature,key:operationKey()};
        await api.call(`dateAutomation.${name}`,{...payload,operationKey:retry.current.key});
        retry.current=null;
        changed();
      }
    }catch(e){setError(explain(e));}finally{setBusy(false);}
  }
  return <fieldset disabled={busy}><legend>{title(kind)} greeting · {def?.enabled?'Active':def?'Paused':'Draft'}</legend>
    {(giftDeliveryEnabled||settings.giftCampaignId)&&<label>Funded gift campaign ID (optional)<input value={settings.giftCampaignId??''} onChange={e=>edit({giftCampaignId:e.target.value.trim()||undefined})}/></label>}
    {settings.giftCampaignId&&<p>Each eligible recipient must already have a reserved offer in this campaign. The greeting reads “{giftGreetingBody}” followed by their personal link.</p>}
    {!settings.giftCampaignId&&<><label>SMS greeting<textarea maxLength={1000} value={settings.sms} onChange={e=>edit({sms:e.target.value})}/></label>
    <p>Use {'{{firstName}}'} or {'{{label}}'}. For known anniversary years, use {'{{#years}}{{years}} years!{{/years}}'}.</p></>}
    <label>Local send time<input type="time" value={settings.time} onChange={e=>edit({time:e.target.value})}/></label>
    <label>Fallback time zone<input value={settings.zone} onChange={e=>edit({zone:e.target.value})}/></label>
    <label>Window opens at hour<input type="number" min={9} max={19} value={settings.startHour} onChange={e=>edit({startHour:e.target.valueAsNumber})}/></label>
    <label>Window closes at hour<input type="number" min={10} max={20} value={settings.endHour} onChange={e=>edit({endHour:e.target.valueAsNumber})}/></label>
    <label><input type="checkbox" checked={!!settings.email} onChange={e=>edit({email:e.target.checked?{subject:title(kind)+' greeting',body:settings.sms}:null})}/>Use email when the recipient is ineligible for SMS</label>
    {settings.email&&!settings.giftCampaignId&&<><label>Email subject<input value={settings.email.subject} onChange={e=>edit({email:{...settings.email!,subject:e.target.value}})}/></label>
      <label>Email greeting<textarea value={settings.email.body} onChange={e=>edit({email:{...settings.email!,body:e.target.value}})}/></label><p>Each fallback uses one email and one campaign slot.</p></>}
    {settings.email&&settings.giftCampaignId&&<p>Email subject: {giftGreetingSubject}. Each fallback uses one email and one campaign slot.</p>}
    {!settings.giftCampaignId&&<><p><strong>Example with a name</strong> {renderGreeting(settings.sms,'Taylor',title(kind),kind==='anniversary'?3:null)}</p>
    <p><strong>Example without a name or year</strong> {renderGreeting(settings.sms,null,title(kind),null)}</p></>}
    <button type="button" onClick={()=>void action('preview')}>Preview next 30 days</button>
    {preview&&<div role="status">{!preview.rows.length&&<p>No upcoming dates on this page.</p>}
      <ul>{preview.rows.map(r=><li key={r.id}>{r.recipient} · {r.hold?'Held · '+r.hold.replaceAll('_',' ')+' · '+new Date(r.dueAt).toLocaleDateString(undefined,{timeZone:r.zone}):local(r.dueAt,r.zone)} ({r.zone}) · {r.channel} {r.message}</li>)}</ul>
      {preview.next&&<button onClick={()=>void action('preview',preview.next)}>Preview more contacts</button>}</div>}
    <button type="button" disabled={!dirty} onClick={()=>void action('save')}>{def?.enabled?'Save and pause':'Save draft'}</button>
    {def?.enabled?<button type="button" onClick={()=>void action('pause')}>Pause greeting</button>:
      def&&!dirty&&mode!=='off'&&(!settings.giftCampaignId||giftDeliveryEnabled)&&<button type="button" onClick={()=>setReview(true)}>Review activation</button>}
    {mode==='off'&&<p>Recurring delivery is disabled in this environment. Drafts and previews are available.</p>}
    {settings.giftCampaignId&&!giftDeliveryEnabled&&<p>Gift delivery is unavailable for this brand.</p>}
    {review&&<div>{settings.giftCampaignId&&<p>Use reserved offers from campaign {settings.giftCampaignId}.</p>}<p>Activate revision {def?.revision} every year at {settings.time} recipient local time. Channel: SMS{settings.email?' with eligible email fallback':''}. Mode: {mode}.</p>
      <button onClick={()=>void action('activate')}>Confirm annual greeting</button></div>}
    {error&&<p role="alert">{error}</p>}
  </fieldset>;
}

function History({api,brandId,refresh,changed}:Props&{refresh:number;changed:()=>void}) {
  const [view,setView]=useState('upcoming'),[offset,setOffset]=useState(0),[rows,setRows]=useState<DateOccurrence[]>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;setRows(undefined);setError('');
    api.call<{rows:DateOccurrence[]}>('dateAutomation.occurrences',{brandId,view,offset}).then(v=>{if(active)setRows(v.rows);}).catch(e=>{if(active)setError(explain(e));});
    return ()=>{active=false;};
  },[api,brandId,view,offset,refresh]);
  async function cancel(id:string) {
    setBusy(true);
    try{await api.call('dateAutomation.cancel',{brandId,id,operationKey:operationKey()});changed();}catch(e){setError(explain(e));}finally{setBusy(false);}
  }
  return <section><h3>Scheduled greetings</h3><label>Show <select value={view} onChange={e=>{setView(e.target.value);setOffset(0);}}><option value="upcoming">Upcoming</option><option value="history">History</option></select></label>
    <button onClick={changed}>Refresh greetings</button>
    {error&&<p role="alert">{error}</p>}{rows?.length===0&&<p>No greetings in this view.</p>}
    <ul>{rows?.slice(0,50).map(r=><li key={r.id}><strong>{r.recipient??'Unavailable contact'}</strong> · {title(r.kind)} · {local(r.due_at,r.zone)} ({r.zone}) · {r.channel??''} {r.delivery_state??r.state} {r.reason?.replaceAll('_',' ')}
      {(r.state==='planned'||r.state==='queued'&&['pending','preparing','prepared'].includes(r.delivery_state??''))&&<button disabled={busy} onClick={()=>void cancel(r.id)}>Cancel this greeting</button>}</li>)}</ul>
    {offset>0&&<button onClick={()=>setOffset(v=>v-50)}>Previous greetings</button>}
    {rows&&rows.length>50&&<button onClick={()=>setOffset(v=>v+50)}>Next greetings</button>}
  </section>;
}
