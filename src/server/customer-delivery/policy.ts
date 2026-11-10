import {z} from 'zod';
import type {DeliveryScope} from '../../shared/customer-delivery.js';

/** Transport and permitted message purpose are independent. Neither activates billing. */
export function customerDeliveryScope(env:NodeJS.ProcessEnv):DeliveryScope {
  return z.enum(['all','tests']).parse(env.FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE??'all');
}

export function requireMailingActivation(environment:string,env:NodeJS.ProcessEnv,scope:DeliveryScope) {
  if(environment!=='production')throw Error('Customer mailing requires production.');
  const approved=scope==='tests'?env.FLOCKLETTER_TEST_MAILING_APPROVED:env.FLOCKLETTER_LIVE_MAILING_APPROVED;
  if(approved!=='true')throw Error(scope==='tests'
    ?'Test-only customer mailing requires explicit test activation approval.'
    :'Customer mailing requires explicit activation approval.');
}

/** Used before review, approval and new worker submission; unknown scopes deny work. */
export function deliveryPurposeAllowed(scope:DeliveryScope|undefined,purpose:'broadcast'|'test') {
  return (scope===undefined||scope==='all')&&(purpose==='broadcast'||purpose==='test')||scope==='tests'&&purpose==='test';
}
