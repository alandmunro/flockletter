import { useCallback,useEffect,useId,useRef,useState,type FormEvent } from 'react';
import { operationKey,type Api } from './api.js';
import type { CustomerSenderProfile } from '../shared/customer-delivery.js';
type Fields=Omit<CustomerSenderProfile,'revision'>;
type Result={profile:CustomerSenderProfile|null;eligible:boolean;mode:string};
const empty:Fields={fromName:'',fromEmail:'',replyTo:'',organization:'',postalAddress:''};
const controls=[['fromName','From name','text',100],['fromEmail','From email','email',254],['replyTo','Reply-to email','email',254],['organization','Business or organization','text',150],['postalAddress','Postal address for the email footer','text',500]] as const;
export function SenderProfilePanel({api,brandId,onSaved}:{api:Api;brandId:string;onSaved?:()=>void}) {
  const id=useId(),[fields,setFields]=useState<Fields>(empty),[result,setResult]=useState<Result|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[saved,setSaved]=useState(false);
  const attempt=useRef<{signature:string;key:string}|null>(null),request=useRef(0);
  const load=useCallback(async(resetFields=true)=>{
    const current=++request.current;
    const result=await api.call<Result>('delivery.sender',{brandId});
    if(current!==request.current)return;
    setResult(result);setError('');
    if(resetFields){const profile=result.profile;setFields(profile?{fromName:profile.fromName,fromEmail:profile.fromEmail,replyTo:profile.replyTo,organization:profile.organization,postalAddress:profile.postalAddress}:empty);}
    setLoaded(true);
  },[api,brandId]);
  useEffect(()=>{let active=true;void load().catch(error=>{if(active)setError(error instanceof Error?error.message:'The sender profile could not load.');});return()=>{active=false;request.current++;};},[load]);
  async function refresh() {
    setBusy(true);setError('');setResult(previous=>previous?{...previous,eligible:false}:null);
    try{await load(!loaded);}catch(error){setError(error instanceof Error?error.message:'The latest sender checks are unavailable.');}
    finally{setBusy(false);}
  }
  async function save(event:FormEvent) {
    event.preventDefault();request.current++;setBusy(true);setError('');setSaved(false);setResult(previous=>previous?{...previous,eligible:false}:null);
    const signature=JSON.stringify(fields),key=attempt.current?.signature===signature?attempt.current.key:operationKey();attempt.current={signature,key};
    try {
      const profile=await api.call<CustomerSenderProfile>('delivery.saveSender',{brandId,operationKey:key,...fields});
      setFields({fromName:profile.fromName,fromEmail:profile.fromEmail,replyTo:profile.replyTo,organization:profile.organization,postalAddress:profile.postalAddress});
      setResult(previous=>({profile,eligible:false,mode:previous?.mode??'off'}));attempt.current=null;setSaved(true);onSaved?.();
      try{await load(false);}catch{setError('Sender profile saved. The latest verification could not refresh; retry sender checks before reviewing delivery.');}
    }catch(error){setError(error instanceof Error?error.message:'The profile could not save. Retry with the same fields.');}finally{setBusy(false);}
  }
  return <section className="card"><h2>Sender identity and footer</h2>
    <p>Use the business identity readers recognize and a valid postal address. Saving changes requires a fresh review of any campaign awaiting delivery.</p>
    {error&&<p role="alert" className="notice error">{error}</p>}
    {!loaded?<button className="btn secondary" disabled={busy} onClick={()=>void refresh()}>Load sender profile</button>:<form onSubmit={event=>void save(event)}><fieldset disabled={busy}>
      {controls.map(([name,label,type,maximum])=><div className="field" key={name}><label htmlFor={id+'-'+name}>{label}</label><input id={id+'-'+name} type={type} required minLength={name==='postalAddress'?10:1} maxLength={maximum} value={fields[name]} onChange={event=>{setFields(previous=>({...previous,[name]:event.target.value}));setSaved(false);}}/></div>)}
      <button className="btn" type="submit">{busy?'Saving…':'Save sender profile'}</button>
    </fieldset></form>}
    {loaded&&<button className="btn secondary" disabled={busy} onClick={()=>void refresh()}>Refresh sender checks</button>}
    {saved&&<p role="status" className="notice success">Sender profile saved. Existing delivery reviews keep their original identity.</p>}
    {result&&<p className="help">{result.mode==='capture'?'Staging captures use this footer. External email stays disabled.':result.eligible?'Sender checks are current.':'External delivery also requires verified domain ownership and provider configuration.'}</p>}
  </section>;
}
