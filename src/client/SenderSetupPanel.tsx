import {useCallback,useEffect,useRef,useState} from 'react';
import type {Api} from './api.js';
import {operationKey} from './api.js';
import type {SenderSetupView} from '../shared/sender-setup.js';
import {SenderSetupDetails} from './SenderSetupDetails.js';

export function SenderSetupPanel({api,brandId,refreshRevision=0}:{api:Api;brandId:string;refreshRevision?:number}){
 const [view,setView]=useState<SenderSetupView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const context=useRef(0),pending=useRef(new Map<string,string>()),acting=useRef(false);
 const refresh=useCallback(async()=>{const serial=++context.current;try{const next=await api.call<SenderSetupView>('senderSetup.status',{brandId});if(context.current===serial){setView(next);setError('');}}catch(e){if(context.current===serial)setError(e instanceof Error?e.message:'Refresh sender setup.');}},[api,brandId]);
 useEffect(()=>{setView(null);setError('');void refresh();return()=>{context.current++;};},[refresh,refreshRevision]);
 async function act(name:'senderSetup.review'|'senderSetup.approve'|'senderSetup.process'){
  if(!view||acting.current)return;acting.current=true;setBusy(true);setError('');const serial=context.current;
  const payload=name==='senderSetup.review'?{brandId,senderRevision:view.senderRevision}:name==='senderSetup.approve'?{brandId,setupId:view.setup!.id,senderRevision:view.setup!.senderRevision}:{brandId,setupId:view.setup!.id};
  const signature=JSON.stringify([name,payload]);let key=pending.current.get(signature);if(!key){key=operationKey();pending.current.set(signature,key);}
  try{const next=await api.call<SenderSetupView>(name,{...payload,operationKey:key});pending.current.delete(signature);if(serial===context.current)setView(next);}
  catch(e){if(serial===context.current)setError(e instanceof Error?e.message:'Retry this existing sender setup.');}
  finally{acting.current=false;setBusy(false);}
 }
 return <>{error&&<p className="notice error" role="alert">{error}</p>}{view?<SenderSetupDetails view={view} busy={busy} onReview={()=>void act('senderSetup.review')} onApprove={()=>void act('senderSetup.approve')} onRefresh={()=>void act('senderSetup.process')}/>:<p role="status">Loading sending-domain setup…</p>}<button className="btn secondary" disabled={busy} onClick={()=>void refresh()}>Refresh sender setup status</button></>;
}
