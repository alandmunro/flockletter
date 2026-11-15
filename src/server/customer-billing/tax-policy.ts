import {createHash} from 'node:crypto';
import type Stripe from 'stripe';
import type {BillingTaxMode} from '../../shared/billing-tax.js';

export function billingTaxMode(value:string|undefined,required=false):BillingTaxMode|undefined {
 if(value==='off'||value==='stripe-automatic')return value;
 if(value!==undefined||required)throw Error('An explicit supported Flockletter tax collection mode is required.');
 return undefined;
}

/** Verify provider facts, including manual taxes; disabling automatic tax alone is insufficient. */
export function verifyNoTaxSubscription(subscription:Stripe.Subscription) {
 const empty=(rates:unknown)=>rates===null||Array.isArray(rates)&&rates.length===0;
 const invoice=typeof subscription.latest_invoice==='object'?subscription.latest_invoice:null;
 if(typeof subscription.latest_invoice==='string'||subscription.automatic_tax?.enabled!==false||
  !(subscription.managed_payments===null||subscription.managed_payments?.enabled===false)||!empty(subscription.default_tax_rates)||
  subscription.items.data.some(item=>!empty(item.tax_rates))||
  invoice&&(invoice.automatic_tax?.enabled!==false||!empty(invoice.default_tax_rates)||
   !(invoice.total_taxes===null||Array.isArray(invoice.total_taxes)&&invoice.total_taxes.every(tax=>tax.amount===0))))
  throw Error('The subscription tax collection facts could not be verified.');
}

/** Country is authoritative provider data; a URL or client checkbox cannot replace it. */
export function usBillingLocation(address:Stripe.Address|null|undefined){
 if(!address||address.country!=='US'||!address.line1?.trim()||!address.city?.trim()||!/^[A-Z]{2}$/.test(address.state??'')||!/^\d{5}(?:-\d{4})?$/.test(address.postal_code??''))throw Error('A complete US business billing address is required.');
 return {country:'US',line1:address.line1.trim(),line2:address.line2?.trim()??'',city:address.city.trim(),state:address.state!,postal_code:address.postal_code!};
}
export function locationDigest(address:Stripe.Address|null|undefined){return createHash('sha256').update(JSON.stringify(usBillingLocation(address))).digest('hex');}
