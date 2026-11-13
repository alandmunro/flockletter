import {createHash} from 'node:crypto';
import type Stripe from 'stripe';

/** Country is authoritative provider data; a URL or client checkbox cannot replace it. */
export function usBillingLocation(address:Stripe.Address|null|undefined){
 if(!address||address.country!=='US'||!address.line1?.trim()||!address.city?.trim()||!/^[A-Z]{2}$/.test(address.state??'')||!/^\d{5}(?:-\d{4})?$/.test(address.postal_code??''))throw Error('A complete US business billing address is required.');
 return {country:'US',line1:address.line1.trim(),line2:address.line2?.trim()??'',city:address.city.trim(),state:address.state!,postal_code:address.postal_code!};
}
export function locationDigest(address:Stripe.Address|null|undefined){return createHash('sha256').update(JSON.stringify(usBillingLocation(address))).digest('hex');}
