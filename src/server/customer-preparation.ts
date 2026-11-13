import type {CustomerPreparationCheck} from '../shared/customer-operations.js';
import {trialRegistryFromEnvironment} from './customer-abuse/registry.js';

/** Pure, redacted configuration observations. Never constructs a transport or changes activation. */
export function customerPreparation(env:NodeJS.ProcessEnv):CustomerPreparationCheck[] {
  const groups:Record<string,string[]>={
    'Billing provider':[
      'FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT','FLOCKLETTER_CUSTOMER_STRIPE_KEY',
      'FLOCKLETTER_CUSTOMER_STRIPE_WEBHOOK','FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG',
      'FLOCKLETTER_CUSTOMER_STRIPE_PORTAL_CONFIG','FLOCKLETTER_CUSTOMER_STARTER_PORTAL_CONFIG',
      'FLOCKLETTER_CUSTOMER_GROWTH_PORTAL_CONFIG','FLOCKLETTER_CUSTOMER_PRO_PORTAL_CONFIG',
      'FLOCKLETTER_CUSTOMER_STARTER_PRICE','FLOCKLETTER_CUSTOMER_GROWTH_PRICE','FLOCKLETTER_CUSTOMER_PRO_PRICE'],
    'Trial protection':[
      'FLOCKLETTER_TRIAL_HMAC_KEY','FLOCKLETTER_TRIAL_POLICY_ID','FLOCKLETTER_TRIAL_POLICY_VERSION',
      'FLOCKLETTER_TRIAL_RETENTION_APPROVED','FLOCKLETTER_TRIAL_HISTORY_BASELINE'],
    'Newsletter transport credentials':['FLOCKLETTER_CUSTOMER_SES_ACCESS_KEY_ID','FLOCKLETTER_CUSTOMER_SES_SECRET_ACCESS_KEY'],
    'Subscription confirmations':[
      'FLOCKLETTER_CUSTOMER_CONFIRMATION_KEY','FLOCKLETTER_CUSTOMER_CONFIRMATION_RETRIEVE_KEY',
      'FLOCKLETTER_CUSTOMER_CONFIRMATION_FROM','FLOCKLETTER_CUSTOMER_CONFIRMATION_WEBHOOK_SECRET',
      'FLOCKLETTER_CUSTOMER_CONFIRMATION_ROUTING_KEY','FLOCKLETTER_CUSTOMER_CONFIRMATION_SIGNING_KEY'],
    'Support transport credentials':['FLOCKLETTER_SUPPORT_RESEND_KEY','FLOCKLETTER_SUPPORT_RESEND_RETRIEVE_KEY','FLOCKLETTER_SUPPORT_SENDER'],
  };
  if(env.FLOCKLETTER_CUSTOMER_DELIVERY==='resend'||env.FLOCKLETTER_CUSTOMER_RESEND_BINDINGS)groups['Resend newsletter transport']=['FLOCKLETTER_CUSTOMER_RESEND_KEY','FLOCKLETTER_CUSTOMER_RESEND_RETRIEVE_KEY','FLOCKLETTER_CUSTOMER_RESEND_WEBHOOK_SECRET','FLOCKLETTER_CUSTOMER_RESEND_BINDINGS'];
  if(env.FLOCKLETTER_CUSTOMER_DELIVERY==='resend'&&!env.FLOCKLETTER_CUSTOMER_SES_BINDINGS)delete groups['Newsletter transport credentials'];
  const checks:CustomerPreparationCheck[]=Object.entries(groups).map(([area,keys])=>{
    const missing=keys.filter(key=>!env[key]?.trim()).length;
    if(missing)return {area,state:'settings_missing',detail:`${missing} required setting${missing===1?' is':'s are'} missing. This workflow remains subject to its activation and verification checks.`};
    if(area==='Trial protection') {
      try {
        const source=env.APP_ENV==='production'?'stripe_live':'stripe_test';
        if(!/^acct_[A-Za-z0-9]+$/.test(env.FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT??'')||
          !trialRegistryFromEnvironment(env,source,env.FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT!))throw Error('Invalid trial configuration.');
      }catch{return {area,state:'settings_invalid',detail:'Trial settings do not satisfy the protected registry configuration. Review the stable key, approved policy and history baseline; do not reset existing history.'};}
    }
    return {area,state:'settings_recorded',detail:'This configuration group is recorded. Additional sender routes, receiving, operator and hosting setup may still be needed. Settings do not verify permissions, provider acceptance, history, legal/tax readiness or approval to activate.'};
  });
  if(env.FLOCKLETTER_CUSTOMER_BILLING==='stripe_live')checks.push({area:'Address-based subscription tax',state:env.FLOCKLETTER_BILLING_TAX==='stripe-automatic'?'settings_recorded':'settings_missing',detail:'Live subscriptions require automatic tax, the exact business SaaS product code, tax-exclusive prices and independently verified registrations. Recorded settings do not verify local taxability.'});
  if(env.FLOCKLETTER_RESEND_SELF_SERVICE==='approved')checks.push({area:'Customer sender setup',state:env.FLOCKLETTER_RESEND_PROVISION_KEY&&env.FLOCKLETTER_RESEND_PROVISION_KEY!==env.FLOCKLETTER_CUSTOMER_RESEND_KEY&&env.FLOCKLETTER_RESEND_PROVISION_KEY!==env.FLOCKLETTER_CUSTOMER_RESEND_RETRIEVE_KEY?'settings_recorded':'settings_missing',detail:'Owned customer domains require a separate provisioning key, available domain capacity and a matching multi-domain sending key. No plan upgrade or message follows from setup.'});
  if(env.FLOCKLETTER_OPERATOR_MFA_POLICY==='pre-revenue')checks.push({area:'Administrator sign-in',state:'settings_recorded',detail:'Temporary single-factor exception: named operators still need the separate operator organization, current admin membership and a sign-in verified within five minutes. Restore MFA once paying customers arrive; hosted erasure signing stays disabled. This setting does not activate operator access.'});
  return checks;
}
