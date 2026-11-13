import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import Stripe from 'stripe';
import {inspectStripeBillingConfiguration,type BillingInspectionTarget} from '../src/server/customer-billing/configuration-inspection.js';

/** Operator-only reads: no runtime construction, activation switch or provider mutation. */
export async function inspectCustomerBillingEnvironment(env:NodeJS.ProcessEnv,
  clientFactory:(key:string)=>Stripe=key=>new Stripe(key,{maxNetworkRetries:0,timeout:7000})) {
  const environment=env.APP_ENV??'local',live=environment==='production';
  const failure=(name:'configuration'|'inspection',status:'fail'|'unavailable')=>({verified:false,live,checks:[{name,status}]});
  const mode=env.FLOCKLETTER_CUSTOMER_BILLING??'off',key=env.FLOCKLETTER_CUSTOMER_STRIPE_KEY??'';
  const target:BillingInspectionTarget={taxEnabled:env.FLOCKLETTER_BILLING_TAX==='stripe-automatic',account:env.FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT??'',live,origin:env.APP_ORIGIN??'',
    cardConfiguration:env.FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG??'',portalConfiguration:env.FLOCKLETTER_CUSTOMER_STRIPE_PORTAL_CONFIG??'',
    planPortalConfigurations:{starter:env.FLOCKLETTER_CUSTOMER_STARTER_PORTAL_CONFIG??'',growth:env.FLOCKLETTER_CUSTOMER_GROWTH_PORTAL_CONFIG??'',pro:env.FLOCKLETTER_CUSTOMER_PRO_PORTAL_CONFIG??''},
    prices:{starter:env.FLOCKLETTER_CUSTOMER_STARTER_PRICE??'',growth:env.FLOCKLETTER_CUSTOMER_GROWTH_PRICE??'',pro:env.FLOCKLETTER_CUSTOMER_PRO_PRICE??''}};
  try{
    const origin=new URL(target.origin);
    if(!['local','test','staging','production'].includes(environment)||
      !['off',live?'stripe_live':'stripe_test'].includes(mode)||
      !new RegExp('^(sk|rk)_'+(live?'live':'test')+'_[A-Za-z0-9]+$').test(key)||
      !/^acct_[A-Za-z0-9]+$/.test(target.account)||!/^pmc_[A-Za-z0-9]+$/.test(target.cardConfiguration)||
      !/^bpc_[A-Za-z0-9]+$/.test(target.portalConfiguration)||
      !Object.values(target.planPortalConfigurations).every(id=>/^bpc_[A-Za-z0-9]+$/.test(id))||
      new Set([target.portalConfiguration,...Object.values(target.planPortalConfigurations)]).size!==4||
      !Object.values(target.prices).every(price=>/^price_[A-Za-z0-9]+$/.test(price))||new Set(Object.values(target.prices)).size!==3||
      origin.protocol!=='https:'||origin.origin!==target.origin||origin.username||origin.password)
      return failure('configuration','fail');
  }catch{return failure('configuration','fail');}
  try{return await inspectStripeBillingConfiguration(clientFactory(key),target);}
  catch{return failure('inspection','unavailable');}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=await inspectCustomerBillingEnvironment(process.env);
  process.stdout.write(JSON.stringify(result)+'\n');
  process.exitCode=result.verified?0:1;
}
