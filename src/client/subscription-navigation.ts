import {plans} from '../shared/contracts.js';
import type {CustomerPlan} from '../shared/customer-billing.js';

export type BillingReturn = 'card-returned' | 'card-cancelled' | 'returned' | 'cancelled' | 'managed';
type LocationHint = {pathname:string;search:string};
const planIds = new Set<string>(plans.map(plan=>plan.id));
const billingReturns = new Set(['card-returned','card-cancelled','returned','cancelled','managed']);

/** Navigation hints never establish identity, eligibility, price or provider success. */
export function subscriptionEntry(location:LocationHint) {
  const allowedPath=['/','/sign-up','/subscription'].includes(location.pathname);
  const query=new URLSearchParams(location.search);
  const candidate=query.get('plan');
  const plan=allowedPath&&query.getAll('plan').length===1&&candidate&&planIds.has(candidate)?candidate as CustomerPlan:undefined;
  const returned=query.get('billing');
  const billingReturn=allowedPath&&query.getAll('billing').length===1&&returned&&billingReturns.has(returned)?returned as BillingReturn:undefined;
  return {plan,billingReturn,subscription:allowedPath&&(location.pathname==='/sign-up'||location.pathname==='/subscription'||Boolean(plan)||Boolean(billingReturn))};
}

export function browserSubscriptionEntry(){
  return subscriptionEntry(typeof window==='undefined'?{pathname:'/',search:''}:window.location);
}

function planQuery(plan:CustomerPlan|undefined,billingReturn?:BillingReturn){
  const query=new URLSearchParams();
  if(plan&&planIds.has(plan))query.set('plan',plan);
  if(billingReturn&&billingReturns.has(billingReturn))query.set('billing',billingReturn);
  return query.size?'?'+query.toString():'';
}
export const subscriptionSignupUrl=(plan?:CustomerPlan)=>'/sign-up'+planQuery(plan);
export const subscriptionUrl=(plan?:CustomerPlan,billingReturn?:BillingReturn)=>'/subscription'+planQuery(plan,billingReturn);
export function authenticationReturnUrl(location:LocationHint){
  if(location.pathname==='/operator')return '/operator';
  const entry=subscriptionEntry(location);
  return entry.subscription?subscriptionUrl(entry.plan,entry.billingReturn):'/';
}
