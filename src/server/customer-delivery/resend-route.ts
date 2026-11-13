import {createHash} from 'node:crypto';
import {z} from 'zod';
import {senderDomain} from '../../shared/sender.js';
const binding=z.object({workspaceId:z.string().regex(/^org_[A-Za-z0-9_-]{1,120}$/),brandId:z.uuid(),from:z.email().max(254),domainId:z.uuid(),webhookId:z.uuid(),region:z.enum(['us-east-1'])}).strict();
export type ResendRoute=z.infer<typeof binding>&{fingerprint:string};
export function parseResendRoute(raw:unknown):ResendRoute {
 const route=binding.parse(raw),domain=route.from.split('@')[1]!;
 senderDomain.parse(domain);
 return Object.freeze({...route,fingerprint:createHash('sha256').update(JSON.stringify(['customer-resend-v1',route.workspaceId,route.brandId,route.from,route.domainId,route.webhookId,route.region])).digest('hex')});
}

export function storedResendRoute(raw:unknown):ResendRoute{
 const {fingerprint,...fields}=binding.extend({fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).parse(raw);
 const route=parseResendRoute(fields);if(route.fingerprint!==fingerprint)throw Error('Invalid stored sender route.');return route;
}
