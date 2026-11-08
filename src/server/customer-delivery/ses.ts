import { SESv2Client,SendEmailCommand,type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { z } from 'zod';
import type { CustomerProvider } from './types.js';
import type { DeliveryEnvelope } from '../campaign/delivery-provider.js';
import { inlineOriginals } from '../campaign/ses-simulator.js';
import { parseSesRoute,type SesRoute } from '../campaign/ses-runtime.js';
import { createSesInspector } from '../campaign/ses-inspection.js';

export class CustomerSesProvider implements CustomerProvider {
  readonly route:SesRoute;
  readonly fingerprint:string;
  readonly from:string;
  constructor(route:SesRoute,private origin:string,
    private send:(input:SendEmailCommandInput)=>Promise<{MessageId?:string}>,readonly ready:()=>Promise<boolean>) {
    this.fingerprint=route.fingerprint;
    this.from=route.from;
    this.route=Object.freeze({...route});
  }
  async submit(message:DeliveryEnvelope):ReturnType<CustomerProvider['submit']> {
    const route=this.route,unsubscribe=message.unsubscribe?.url;
    if(message.workspaceId!==route.workspaceId||message.brandId!==route.brandId||!z.uuid().safeParse(message.operationKey).success||
      !z.email().safeParse(message.to).success||/[\p{Cc}\p{Cf}]/u.test(message.subject)||message.subject.length>150||!unsubscribe||/[\p{Cc}\p{Cf}]/u.test(unsubscribe)||
      (message.sender&&(!z.email().safeParse(message.sender.replyTo).success||/[\p{Cc}\p{Cf}]/u.test(message.sender.name))))
      return {outcome:'rejected'};
    let link:URL;
    try{link=new URL(unsubscribe);}catch{return {outcome:'rejected'};}
    if(link.origin!==this.origin||link.pathname!=='/newsletter/opt-out'||link.username||link.password||link.searchParams.size!==1||
      !/^[A-Za-z0-9_-]{1,1000}$/.test(link.searchParams.get('t')??'')||link.hash||link.href!==unsubscribe)
      return {outcome:'rejected'};
    const attachments=inlineOriginals(message);
    if(!attachments)return {outcome:'rejected'};
    try {
      if(!await this.ready())return {outcome:'not_submitted'};
      const result=await this.send({TenantName:route.tenant,ConfigurationSetName:route.configurationSet,
        ConfigurationOverrides:{Tracking:{OpenTrackingEnabled:'DISABLED',ClickTrackingEnabled:'DISABLED'}},
        FromEmailAddress:message.sender?'"'+message.sender.name.replace(/["\\]/g,'')+'" <'+route.from+'>':route.from,
        FromEmailAddressIdentityArn:route.identityArn,...(message.sender?{ReplyToAddresses:[message.sender.replyTo]}:{}),
        Destination:{ToAddresses:[message.to]},
        EmailTags:[{Name:'fl_operation',Value:message.operationKey},{Name:'fl_tenant',Value:route.tenant},
          {Name:'fl_customer',Value:'1'},{Name:'fl_brand',Value:route.brandId}],
        Content:{Simple:{Subject:{Charset:'UTF-8',Data:message.subject},
          Body:{Html:{Charset:'UTF-8',Data:message.html},Text:{Charset:'UTF-8',Data:message.text}},Attachments:attachments,
          Headers:[{Name:'List-Unsubscribe',Value:'<'+unsubscribe+'>'},{Name:'List-Unsubscribe-Post',Value:'List-Unsubscribe=One-Click'}]}}});
      return result.MessageId?.trim()?{outcome:'accepted',messageId:result.MessageId}:{outcome:'unknown'};
    }catch(error) {
      const name=(error as {name?:string})?.name;
      if(name&&['BadRequestException','MailFromDomainNotVerifiedException','MessageRejected','AccountSuspendedException','SendingPausedException','NotFoundException'].includes(name))
        return {outcome:'rejected'};
      return {outcome:'unknown'};
    }
  }
  async lookup(_operation:string):ReturnType<CustomerProvider['lookup']> {
    // SES has no authoritative lookup by our operation key. Signed SNS facts settle uncertainty.
    return {outcome:'unknown'};
  }
}

export function customerSesRuntime(origin:string,env:NodeJS.ProcessEnv) {
  if(env.FLOCKLETTER_CUSTOMER_DELIVERY!=='ses')return;
  if(env.APP_ENV!=='production'||env.FLOCKLETTER_LIVE_MAILING_APPROVED!=='true')throw Error('Customer SES activation requires explicit production approval.');
  const raw=env.FLOCKLETTER_CUSTOMER_SES_BINDINGS,
    accessKeyId=env.FLOCKLETTER_CUSTOMER_SES_ACCESS_KEY_ID,secretAccessKey=env.FLOCKLETTER_CUSTOMER_SES_SECRET_ACCESS_KEY;
  const dynamic=env.FLOCKLETTER_CUSTOMER_INFRASTRUCTURE==='aws'&&env.FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED==='true';
  if((!raw&&!dynamic)||(raw&&raw.length>65536)||!accessKeyId||!secretAccessKey)throw Error('Configure dedicated customer SES bindings and credentials.');
  if(dynamic&&(!/^\d{12}$/.test(env.FLOCKLETTER_INFRASTRUCTURE_AWS_ACCOUNT_ID??'')||
    !['us-east-1','us-east-2','us-west-1','us-west-2'].includes(env.FLOCKLETTER_INFRASTRUCTURE_AWS_REGION??'')))
    throw Error('Dynamic sending routes require the approved infrastructure account and US region.');
  const routes=raw?z.array(z.unknown()).min(1).max(20).parse(JSON.parse(raw)).map(parseSesRoute):[];
  const credentials={accessKeyId,secretAccessKey,...(env.FLOCKLETTER_CUSTOMER_SES_SESSION_TOKEN?{sessionToken:env.FLOCKLETTER_CUSTOMER_SES_SESSION_TOKEN}:{})};
  type Entry={route:SesRoute;provider:CustomerSesProvider;active:boolean;configuration:boolean;close:()=>void};
  const entries:Entry[]=[];
  function register(route:SesRoute,active:boolean,fromConfiguration=false) {
    const {fingerprint,...fields}=route,verified=parseSesRoute(fields);
    if(fingerprint!==verified.fingerprint)throw Error('A sending route failed its immutable binding check.');
    if(!fromConfiguration&&(!dynamic||route.accountId!==env.FLOCKLETTER_INFRASTRUCTURE_AWS_ACCOUNT_ID||route.region!==env.FLOCKLETTER_INFRASTRUCTURE_AWS_REGION))
      throw Error('A provisioned sending route does not match the approved account and region.');
    const previous=entries.find(entry=>entry.route.fingerprint===fingerprint);
    if(previous){previous.active=previous.configuration||active;return;}
    if(entries.length>=64)throw Error('Sending route capacity requires operator review.');
    for(const entry of entries) {
      const other=entry.route,sameBrand=other.workspaceId===route.workspaceId&&other.brandId===route.brandId;
      const tenant=[route.accountId,route.region,route.tenant].join('/'),otherTenant=[other.accountId,other.region,other.tenant].join('/');
      if((tenant===otherTenant&&route.workspaceId!==other.workspaceId)||
        (route.workspaceId===other.workspaceId&&tenant!==otherTenant)||
        (route.identityArn===other.identityArn&&route.workspaceId!==other.workspaceId)||
        (!sameBrand&&(route.topicArn===other.topicArn||[route.accountId,route.region,route.configurationSet].join('/')===[other.accountId,other.region,other.configurationSet].join('/'))))
        throw Error('Customer workspaces require distinct SES tenants and sender identities, with separate brand feedback resources.');
    }
    const client=new SESv2Client({region:route.region,credentials,maxAttempts:1,ignoreConfiguredEndpointUrls:true});
    const inspector=createSesInspector(route,credentials);
    const status={active};
    const provider=new CustomerSesProvider(route,origin,input=>client.send(new SendEmailCommand(input),{abortSignal:AbortSignal.timeout(6000)}),
      async()=>status.active&&Object.entries(await inspector.check()).every(([key,value])=>key==='checkedAt'||value===true));
    entries.push({route:Object.freeze({...route}),provider,configuration:fromConfiguration,get active(){return status.active;},set active(value){status.active=value;},
      close(){client.destroy();inspector.close();}});
  }
  try {for(const route of routes) {
    if(entries.some(entry=>entry.route.workspaceId===route.workspaceId&&entry.route.brandId===route.brandId))
      throw Error('Each configured brand requires exactly one initial route.');
    register(route,true,true);
  }}catch(error){entries.forEach(entry=>entry.close());throw error;}
  return {entries,register:(route:SesRoute,active:boolean)=>register(route,active),
    provider:(workspace:string,brand:string)=>entries.filter(entry=>entry.active&&entry.route.workspaceId===workspace&&entry.route.brandId===brand).at(-1)?.provider,
    deactivate:(workspace:string)=>entries.filter(entry=>entry.route.workspaceId===workspace&&!entry.configuration).forEach(entry=>{entry.active=false;}),
    close:()=>entries.forEach(entry=>entry.close())};
}
