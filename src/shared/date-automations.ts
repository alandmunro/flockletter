import { z } from 'zod';
import { commandDefinition } from './command-definition.js';

const kind = z.enum(['birthday','anniversary']);
const brandId = z.uuid(), operationKey = z.uuid();
const template = z.string().trim().min(1).max(1000).refine(value =>
  !/[{}]/.test(value.replace(/\{\{(firstName|years|label)\}\}/g,'')), 'Use firstName, years or label inside double braces.');
export const dateSettings = z.object({
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  zone: z.string().max(80).refine(value => {
    try { new Intl.DateTimeFormat('en',{timeZone:value}); return true; } catch { return false; }
  }, 'Choose an IANA time zone.'),
  startHour: z.number().int().min(9).max(19), endHour: z.number().int().min(10).max(20),
  sms: template, email: z.object({ subject: template.max(120), body: template }).strict().nullable(),
}).strict().refine(v=>v.startHour<v.endHour,'The send window must open before it closes.');
export type DateSettings = z.infer<typeof dateSettings>;
export type DateKind = z.infer<typeof kind>;
export type DateDefinition = { kind: DateKind; revision:number; enabled:boolean; settings:DateSettings };
export type DateOccurrence = { id:string; kind:DateKind; local_date:string; due_at:string; zone:string; state:string;
  reason:string|null; channel:string|null; date_id:string; recipient:string|null; delivery_state:string|null };
const revision = {brandId,kind,operationKey,expectedRevision:z.number().int().nonnegative()};
const manage = 'automation:manage';
export const dateCommands = {
  'dateAutomation.list':commandDefinition('Read date automation settings for a brand.',manage,false,{brandId}),
  'dateAutomation.save':commandDefinition('Save a reviewed birthday or anniversary draft. Saving pauses an active revision.',manage,true,{...revision,settings:dateSettings}),
  'dateAutomation.activate':commandDefinition('Authorize recurring marketing under the exact saved revision.',manage,true,{...revision,confirmRecurring:z.literal(true)}),
  'dateAutomation.pause':commandDefinition('Pause recurring sends for one date type.',manage,true,revision),
  'dateAutomation.occurrences':commandDefinition('Read forthcoming annual greetings or their history.',manage,false,{brandId,view:z.enum(['upcoming','history']),offset:z.number().int().nonnegative().default(0)}),
  'dateAutomation.cancel':commandDefinition('Cancel one annual greeting.',manage,true,{brandId,operationKey,id:z.uuid()}),
};
export type DateCommand = keyof typeof dateCommands;

export function renderGreeting(template:string,firstName:string|null,label:string,years:number|null) {
  return template.replace(/\{\{(firstName|label|years)\}\}/g,(_,field:string)=>
    field==='firstName' ? firstName??'friend' : field==='label' ? label : years===null?'':String(years))
    .replace(/[ \t]{2,}/g,' ').trim();
}
