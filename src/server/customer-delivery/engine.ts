import { createServer,type Server } from 'node:http';
import { randomBytes,randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EmbeddedListmonk } from '../campaign/embedded-listmonk.js';
import { privateMessenger } from '../campaign/private-messenger.js';
import { listmonkReference,reviewedListmonkMessage } from '../campaign/listmonk-callback.js';
import type { DeliveryEnvelope } from '../campaign/delivery-provider.js';

type Pending={message:DeliveryEnvelope;resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout};
type Engine={server:Server;engine:EmbeddedListmonk;pending:Map<string,Pending>;active:number;lastUsed:number;drained:Set<()=>void>};

export class CustomerEnginePool {
  private scopes=new Map<string,Promise<Engine>>();
  private closed=false;
  private allocation=Promise.resolve();
  private blocked=new Set<string>();
  readonly bootId=randomUUID();
  constructor(private maximum=1) {
    if(!Number.isInteger(maximum)||maximum<1||maximum>5)throw Error('Configure one to five private renderers.');
  }
  /** Check the pinned build artifact before advertising a configured renderer. */
  async verify() {
    await access(resolve('dist/private/listmonk'),constants.X_OK);
  }
  private async create(_workspace:string):Promise<Engine> {
    const pending=new Map<string,Pending>(), secret=randomBytes(32).toString('hex');
    const server=createServer(privateMessenger(secret,async raw=>{
      const key=typeof raw==='object'&&raw!==null&&'from_email' in raw?String(raw.from_email):'';
      const item=pending.get(key);
      if(!item)throw Error('The renderer callback has no current workspace claim.');
      reviewedListmonkMessage(raw,item.message);
      item.resolve();
    }));
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
    const address=server.address();
    if(!address||typeof address==='string')throw Error('The private renderer listener is unavailable.');
    const engine=new EmbeddedListmonk('http://127.0.0.1:'+address.port+'/message',secret);
    return {server,engine,pending,active:0,lastUsed:Date.now(),drained:new Set()};
  }
  private async entry(workspace:string) {
    if(this.closed)throw Error('The renderer pool is closed.');
    if(this.blocked.has(workspace))throw Error('The workspace renderer is quiesced for retention review.');
    const existing=this.scopes.get(workspace);
    if(existing)return existing;
    if(this.scopes.size>=this.maximum) {
      let retired=false;
      for(const [key,loading] of this.scopes) {
        const entry=await loading;
        if(entry.active)continue;
        this.scopes.delete(key);await this.dispose(entry);retired=true;break;
      }
      if(!retired)throw Error('The private renderers are processing other workspaces. Retry the saved job.');
    }
    const loading=this.create(workspace);
    this.scopes.set(workspace,loading);
    try{return await loading;}catch(error){if(this.scopes.get(workspace)===loading)this.scopes.delete(workspace);throw error;}
  }
  async render(message:DeliveryEnvelope) {
    let release!:()=>void;
    const previous=this.allocation;
    this.allocation=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    let entry:Engine;
    try{entry=await this.entry(message.workspaceId);entry.active++;}finally{release();}
    const reference=listmonkReference(message.workspaceId,message.brandId,message.operationKey);
    if(entry.pending.has(reference)){entry.active--;throw Error('This render is already processing.');}
    entry.lastUsed=Date.now();
    let completed:Promise<void>;
    try {
      completed=new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('The private renderer callback timed out.')),45000);
        entry.pending.set(reference,{message,resolve,reject,timer});
      });
      // Attach a handler immediately so a failed HTTP post cannot leave an unhandled callback rejection.
      const callback=completed.catch(error=>{throw error;});
      await Promise.all([entry.engine.render(message,reference),callback]);
    } finally {
      const item=entry.pending.get(reference);if(item)clearTimeout(item.timer);
      entry.pending.delete(reference);entry.active--;entry.lastUsed=Date.now();
      if(!entry.active){for(const resolve of entry.drained)resolve();entry.drained.clear();}
    }
  }
  /** Process-local facts only. This cannot prove disposal on another instance or old host. */
  async quiesce(workspace:string) {
    if(!/^org_[A-Za-z0-9_-]{1,120}$/.test(workspace))throw Error('Use one exact workspace.');
    let release!:()=>void;const previous=this.allocation;this.allocation=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    try {
      this.blocked.add(workspace);
      const loading=this.scopes.get(workspace);
      if(loading){const entry=await loading;if(entry.active)await new Promise<void>(resolve=>entry.drained.add(resolve));await this.dispose(entry);this.scopes.delete(workspace);}
      return {workspaceId:workspace,bootId:this.bootId,quiesced:true as const,processLocalOnly:true as const,observedAt:new Date().toISOString()};
    } finally {release();}
  }
  inspect(workspace:string){return {workspaceId:workspace,bootId:this.bootId,quiesced:this.blocked.has(workspace)&&!this.scopes.has(workspace),processLocalOnly:true as const};}
  private async dispose(entry:Engine) {
    for(const item of entry.pending.values()){clearTimeout(item.timer);item.reject(Error('The renderer is shutting down.'));}
    await entry.engine.close();
    await new Promise<void>(resolve=>entry.server.close(()=>resolve()));
  }
  async close() {
    this.closed=true;
    await this.allocation;
    const pending=[...this.scopes.values()];this.scopes.clear();
    await Promise.allSettled(pending.map(async p=>this.dispose(await p)));
  }
}
