import { z } from 'zod';
import type { Config } from './config.js';
import {operatorMfaPolicy} from './platform/auth-policy.js';

export function customerSettings(config:Config,env:NodeJS.ProcessEnv=process.env) {
  operatorMfaPolicy(config.environment,env);
  const mode=<const T extends readonly [string,...string[]]>(key:string,values:T)=>z.enum(values).parse(env[key]??'off');
  const settings={
    billing:mode('FLOCKLETTER_CUSTOMER_BILLING',['off','exercise','stripe_test','stripe_live']),
    delivery:mode('FLOCKLETTER_CUSTOMER_DELIVERY',['off','capture','ses']),
    audience:mode('FLOCKLETTER_CUSTOMER_AUDIENCE',['off','exercise','live']),
    team:mode('FLOCKLETTER_CUSTOMER_TEAM',['off','exercise','clerk']),
    support:mode('FLOCKLETTER_CUSTOMER_SUPPORT',['off','capture','live']),
    retention:mode('FLOCKLETTER_CUSTOMER_RETENTION',['off','capture','live']),
    infrastructure:mode('FLOCKLETTER_CUSTOMER_INFRASTRUCTURE',['off','capture','aws']),
    dedicated:z.enum(['embedded','dedicated']).parse(env.FLOCKLETTER_CUSTOMER_WORKER??'embedded')==='dedicated',
    renderer:z.enum(['off','embedded']).parse(env.FLOCKLETTER_PRIVATE_ENGINE??'off')==='embedded',
    provisioningMonthlyLimit:z.coerce.number().int().min(0).max(20).parse(env.FLOCKLETTER_INFRASTRUCTURE_MONTHLY_LIMIT??'0'),
    engineCount:z.coerce.number().int().min(1).max(5).parse(env.FLOCKLETTER_CUSTOMER_ENGINE_COUNT??'1'),
  };
  if(config.environment==='production' && Object.values(settings).some(value=>value==='capture'||value==='exercise'))
    throw Error('Captured exercises cannot be enabled in production.');
  if(settings.delivery==='ses' && (config.environment!=='production'||env.FLOCKLETTER_LIVE_MAILING_APPROVED!=='true'))
    throw Error('Customer mailing requires production and explicit activation approval.');
  if(settings.audience==='live' && env.FLOCKLETTER_CONFIRMATION_ACTIVATION_APPROVED!=='true')
    throw Error('Confirmation delivery requires explicit activation approval.');
  if(settings.team==='clerk' && (!config.clerkSecretKey||!config.clerkPublishableKey))
    throw Error('Team administration requires the verified Clerk application.');
  if(settings.support==='live' && env.FLOCKLETTER_SUPPORT_ACTIVATION_APPROVED!=='true')
    throw Error('External support replies require explicit activation approval.');
  if(settings.infrastructure==='aws'&&(config.environment!=='production'||env.FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED!=='true'))
    throw Error('Cloud provisioning requires production and explicit infrastructure activation approval.');
  return settings;
}
export type CustomerSettings=ReturnType<typeof customerSettings>;
