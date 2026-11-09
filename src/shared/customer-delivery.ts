import { z } from 'zod';
import {customerTestSendCommands} from './customer-test-send.js';
import {customerPreflightCommands} from './customer-preflight.js';
import { commandDefinition as command } from './command-definition.js';
import { normalizedEmail } from './subscriber.js';

const id = z.uuid();
const operationKey = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const deliveryRecipientStates = ['pending','preparing','prepared','submitting','uncertain','accepted','rejected','excluded','cancelled'] as const;
export const deliveryFeedbackKinds = ['delivered','hard_bounce','complaint','temporary_bounce'] as const;
export const customerDeliveryCommands = {
  ...customerPreflightCommands,
  ...customerTestSendCommands,
  'delivery.sender':command('Read this brand’s legal sender profile and activation checks.','campaign:send',false,{brandId:id}),
  'delivery.saveSender':command('Save this brand’s sender identity and postal footer. Existing reviewed deliveries require a fresh review.','owner',true,{
    operationKey,brandId:id,fromName:z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}]+$/u),
    fromEmail:normalizedEmail,replyTo:normalizedEmail,organization:z.string().trim().min(1).max(150).regex(/^[^\p{Cc}\p{Cf}]+$/u),
    postalAddress:z.string().trim().min(10).max(500).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  }),
  'delivery.status': command('View delivery mode, workspace usage and current sender checks for an optional authorized brand.', 'campaign:send', false, {brandId:id.optional()}),
  'delivery.list': command('List this brand’s reviewed campaigns and delivery outcomes.', 'campaign:send', false, {brandId:id,purpose:z.enum(['broadcast','test']).optional()}),
  'delivery.review': command('Freeze the saved draft and confirmed audience before approval.', 'campaign:send', true, {
    operationKey,brandId:id,campaignId:id,expectedVersion:z.number().int().positive(),
    segmentId:id.optional(),dueAt:z.iso.datetime({offset:true}).optional(),
  }),
  'delivery.approve': command('Reserve allowance and queue exactly this reviewed campaign.', 'campaign:send', true, {operationKey,brandId:id,id}),
  'delivery.cancel': command('Cancel future submissions and preserve unknown provider outcomes for reconciliation.', 'campaign:send', true, {operationKey,brandId:id,id}),
  'delivery.pause':command('Pause future submissions while keeping the reviewed snapshot and reserved allowance.','campaign:send',true,{operationKey,brandId:id,id}),
  'delivery.resume':command('Resume an unchanged paused review after rechecking current authority, sender and allowance.','campaign:send',true,{operationKey,brandId:id,id}),
  'delivery.report': command('View aggregate outcome and reconciliation state.', 'campaign:send', false, {brandId:id,id}),
  'delivery.outcomes': command('Page through this delivery’s recipient outcomes, with optional state and feedback filters. Read-only; never retries a submission.', 'campaign:send', false, {
    brandId:id,id,after:id.optional(),limit:z.number().int().min(1).max(100).default(25),
    state:z.enum(deliveryRecipientStates).optional(),feedback:z.enum(deliveryFeedbackKinds).optional(),
  }),
  'delivery.process': command('Request processing or reconciliation of the reviewed delivery.', 'campaign:send', true, {operationKey,brandId:id,id}),
  'delivery.message': command('Read one captured exercise email in an authenticated owner session.', 'owner', false, {brandId:id,id,recipientId:id}),
  'delivery.exerciseFeedback': command('Record explicitly captured delivery, bounce or complaint feedback.', 'owner', true, {
    operationKey,brandId:id,id,recipientId:id,kind:z.enum(['delivered','hard_bounce','complaint','temporary_bounce']),
  }),
};

export type DeliveryMode = 'off'|'capture'|'ses';
export type DeliveryRecipientOutcome = {
  id:string;state:typeof deliveryRecipientStates[number];feedback:typeof deliveryFeedbackKinds[number]|null;reason:string|null;attempts:number;
};
export type DeliveryOutcomesPage = {
  deliveryId:string;brandId:string;mode:DeliveryMode;items:DeliveryRecipientOutcome[];
  total:number;nextCursor:string|null;observedAt:string;
};
export type CustomerSenderProfile={fromName:string;fromEmail:string;replyTo:string;organization:string;postalAddress:string;revision:number};
export type DeliveryView = {
  purpose:'broadcast'|'test';testDay:string|null;testAdmittedAt:string|null;
  senderProfile?:CustomerSenderProfile|null;
  id:string; brandId:string; campaignId:string; version:number; subject:string;
  state:string; mode:DeliveryMode; dueAt:string; selected:number; excluded:number;
  pending:number; preparing:number; submitting:number; accepted:number; uncertain:number;
  rejected:number; skipped:number; delivered:number; hardBounced:number; complained:number;
  createdAt:string; reason:string|null;
  recipients:{id:string;state:string;feedback:string|null;reason:string|null;attempts:number}[];
};
