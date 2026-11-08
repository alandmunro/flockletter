import { z } from 'zod';
import { studioSchema, studioAssetIds } from './studio.js';
import { normalizedEmail } from './subscriber.js';
import { stateFilter } from './audience.js';
import { productFields, templateIds } from './authoring.js';
import { rehearsalAudiences, rehearsalTransports } from './rehearsal.js';
import { importPreviewInput } from './import-preview.js';
import { exportPageInput } from './audience-export.js';
import { senderDomain } from './sender.js';
import { companyOrBrandName } from './companies.js';
import {segmentAction,segmentEmails,segmentName} from './segments.js';
import {clerkUserId,teamRole} from './team.js';

export type { IntakeStatus } from './subscriber.js';
export const capabilities = ['read', 'draft:write', 'assets:write', 'subscriber:signup', 'audience:summary','campaign:rehearse','campaign:simulate'] as const;
export type Capability = typeof capabilities[number];
export const limits = { fileBytes: 5 * 1024 * 1024, batchBytes: 20 * 1024 * 1024, batchFiles: 10, imagePixels: 25_000_000, campaignImages: 6, workspaceBytes: 100 * 1024 * 1024, assets: 500, drafts: 100, connections: 10, preparationOperations: 2000 } as const;
export const plans = [
  { id: 'starter', name: 'Starter', currency: 'USD', priceMinor: 1500, contacts: 2500, recipients: 2500, campaigns: 2, emails: 5000, companies: 1, brands: 1, users: 1 },
  { id: 'growth', name: 'Growth', currency: 'USD', priceMinor: 2500, contacts: 5000, recipients: 5000, campaigns: 5, emails: 25000, companies: 3, brands: 3, users: 3 },
  { id: 'pro', name: 'Pro', currency: 'USD', priceMinor: 3900, contacts: 10000, recipients: 10000, campaigns: 20, emails: 100000, companies: 5, brands: 5, users: null },
] as const;
export const contentSchema = z.object({
  layout: z.enum(templateIds).optional(), studio: studioSchema.optional(),
  title: z.string().trim().max(120), subject: z.string().trim().max(150), preheader: z.string().trim().max(200),
  fromName: z.string().trim().max(100), replyTo: z.string().trim().max(254), heading: z.string().trim().max(150),
  body: z.string().max(12000), ctaLabel: z.string().trim().max(60), ctaUrl: z.string().trim().max(2048),
  assetIds: z.array(z.uuid()).max(limits.campaignImages).refine(ids => new Set(ids).size === ids.length, 'Choose each image once.'),
}).strict().superRefine((content,ctx)=>{
  if(!content.studio)return;
  for(const field of ['subject','fromName','replyTo'] as const){
    if(/[\p{Cc}\p{Cs}]/u.test(content[field]))ctx.addIssue({code:'custom',path:[field],message:'Use a single line of printable text.'});
  }
  const referenced=studioAssetIds(content.studio);
  if(referenced.length!==content.assetIds.length||referenced.some((id,index)=>id!==content.assetIds[index]))
    ctx.addIssue({code:'custom',path:['assetIds'],message:'Match the ordered, distinct image IDs used in the Studio blocks.'});
});
export type CampaignContent = z.infer<typeof contentSchema>;
export const emptyContent = (): CampaignContent => ({ title: '', subject: '', preheader: '', fromName: '', replyTo: '', heading: '', body: '', ctaLabel: '', ctaUrl: '', assetIds: [] });
export type AssetSummary = { id: string; name: string; mime: string; size: number; width: number; height: number; sha256: string; createdAt: string };
export type Campaign = { id: string; brandId: string; version: number; content: CampaignContent; createdAt: string; updatedAt: string; status: 'draft' };
export type Brand = { id: string; name: string };
export type Workspace = { name: string; hasDraft?:boolean; canEdit?:boolean; brands: Brand[]; entitlement: 'not_activated'|'complimentary'; canManageConnections: boolean; preparationLimits: typeof limits; plans: typeof plans };
export type Gap = { code: string; title: string; detail: string; area: 'content' | 'sender' | 'audience' | 'billing' | 'delivery' };
export type Preflight = { campaignId: string; version: number; canSend: false; contentReady: boolean; gaps: Gap[]; audience?: { confirmed: number; excluded: number } };
export type Connection = { id: string; name: string; scopes: Capability[]; brandIds: string[]; createdAt: string; expiresAt: string; revokedAt: string | null };

const key = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'Use a stable operation key of 16–128 letters, digits, dashes or underscores.');
const id = z.uuid();
const audienceId = id.toLowerCase();
const descriptor = <T extends z.ZodRawShape>(description: string, scope: Capability | 'owner', mutation: boolean, shape: T) => ({ description, scope, mutation, schema: z.object(shape).strict() });
export const commands = {
  'workspace.get': descriptor('Inspect workspace, plan catalogue and preparation limits. Does not create records.', 'read', false, {}),
  'workspace.preflight': descriptor('Start here: inspect all workspace setup gaps and preparation limits before gathering content or photos. Never starts billing or sends.', 'read', false, {}),
  'workspace.initialize': descriptor('Create the current Clerk organization workspace and first brand once. Does not activate a subscription.', 'owner', true, { operationKey: key, name: z.string().trim().min(1).max(100), brandName: z.string().trim().min(1).max(100) }),
  'workspace.access': descriptor('Read the workspace access source and, for owners, practice usage. Live sends and payments are disabled.', 'read', false, {}),
  'workspace.operations': descriptor('View recent workspace actions and aggregate capture queue health.', 'owner',false,{}),
  'workspace.retention':descriptor('Preview the 90-day review date for a verified sandbox service end.', 'owner',false,{}),
  'team.list':descriptor('List verified Clerk workspace members, brand access and seat capacity.', 'owner',false,{offset:z.number().int().min(0).max(10000000).default(0)}),
  'team.grant':descriptor('Give an existing Clerk workspace member explicit brand preparation access.', 'owner',true,{operationKey:key,userId:clerkUserId,permission:teamRole,brandIds:z.array(id).min(1).max(5)}),
  'team.revoke':descriptor('Remove a member’s Flockletter brand access without changing their Clerk account.', 'owner',true,{operationKey:key,userId:clerkUserId}),
  'company.list':descriptor('List workspace companies, brands and applicable plan limits.', 'owner',false,{}),
  'company.create':descriptor('Create a company within the workspace-wide plan cap.', 'owner',true,{operationKey:key,name:companyOrBrandName}),
  'company.rename':descriptor('Rename a workspace company.', 'owner',true,{operationKey:key,id,name:companyOrBrandName}),
  'brand.create':descriptor('Create a brand in a workspace company within the shared plan cap.', 'owner',true,{operationKey:key,companyId:id,name:companyOrBrandName}),
  'brand.rename':descriptor('Rename a workspace brand and preserve its audience identity.', 'owner',true,{operationKey:key,id,name:companyOrBrandName}),
  'brand.move':descriptor('Move an existing brand to another company in this workspace.', 'owner',true,{operationKey:key,id,companyId:id}),
  'billing.status': descriptor('View workspace-specific Stripe sandbox setup and verified status.', 'owner',false,{}),
  'billing.checkout': descriptor('Open or resume the workspace’s isolated Stripe test checkout.', 'owner',true,{operationKey:z.uuid(),plan:z.enum(['starter','growth','pro'])}),
  'billing.restart': descriptor('Restart a verified, unused expired Stripe test checkout with a new attempt.', 'owner',true,{operationKey:z.uuid(),expiredId:z.uuid(),plan:z.enum(['starter','growth','pro'])}),
  'billing.portal': descriptor('Open the billing portal for this workspace’s sandbox customer.', 'owner',true,{operationKey:z.uuid()}),
  'template.list': descriptor('List built-in newsletter layouts.', 'read', false, {}),
  'sender.status': descriptor('Read the sender ownership challenge and provider status for this brand.', 'owner',false,{brandId:id}),
  'sender.register': descriptor('Create an ownership challenge for this brand domain.', 'owner',true,{operationKey:key,brandId:id,domain:senderDomain}),
  'sender.verify': descriptor('Check the public domain ownership TXT record. This never activates a provider.', 'owner',true,{operationKey:key,brandId:id}),
  'campaign.fromTemplate': descriptor('Create a campaign draft from a newsletter layout.', 'draft:write', true, {operationKey:key,brandId:id,templateId:z.enum(templateIds)}),
  'campaign.fromProduct': descriptor('Prepare a draft from approved product details and existing brand images.', 'draft:write', true, {operationKey:key,brandId:id,...productFields,assetIds:contentSchema.shape.assetIds}),
  'rehearsal.methods': descriptor('List rehearsal methods available to this brand. Ordinary customer delivery is never enabled.', 'campaign:rehearse', false, {brandId:id}),
  'rehearsal.review': descriptor('Freeze this draft, synthetic recipients and test transport. An omitted transport uses the original capture mailbox.', 'campaign:rehearse', true, {operationKey:key,brandId:audienceId,campaignId:id,expectedVersion:z.number().int().positive(),audience:z.enum(rehearsalAudiences),transport:z.enum(rehearsalTransports).optional(),segmentId:audienceId.optional(),dueAt:z.iso.datetime({offset:true}).optional()}),
  'rehearsal.approve': descriptor('Queue only the reviewed method. Local and private Listmonk rehearsals stay inside Flockletter. An explicitly reviewed SES method can reach only AWS simulator addresses.', 'campaign:rehearse', true, {operationKey:key,brandId:id,id}),
  'rehearsal.cancel': descriptor('Stop new submissions. An earlier uncertain attempt retains its reservation until a provider receipt resolves it.', 'campaign:rehearse', true, {operationKey:key,brandId:id,id}),
  'rehearsal.process': descriptor('Process a due capture or request one worker step on the chosen staging provider rehearsal. Uncertain attempts only check provider status.', 'campaign:rehearse', true, {operationKey:key,brandId:id,id}),
  'rehearsal.list': descriptor('List recent brand rehearsal results for a draft.', 'campaign:rehearse',false,{brandId:id,campaignId:id}),
  'rehearsal.report': descriptor('Read counts and outcome for one brand rehearsal.', 'campaign:rehearse',false,{brandId:id,id}),
  'rehearsal.outcomes': descriptor('Read submission attempts, private-renderer progress and reported delivery, bounce or complaint for each synthetic recipient. An uncertain result requires provider reconciliation before any new submission.', 'campaign:rehearse',false,{brandId:id,id}),
  'rehearsal.message': descriptor('Read the reviewed email captured inside Flockletter.', 'campaign:rehearse',false,{brandId:id,id}),
  'audience.previewImport': descriptor('Preview a CSV for one brand. Returns counts and row numbers only.', 'owner', false, importPreviewInput.shape),
  'audience.exportPage': descriptor('Read one bounded page for an explicitly requested owner export.', 'owner',false, exportPageInput.shape),
  'campaign.list': descriptor('List accessible draft campaigns, newest first.', 'read', false, {}),
  'campaign.get': descriptor('Read one authorized draft version.', 'read', false, { id }),
  'campaign.create': descriptor('Prepare a draft in an authorized brand. Optional Studio v1 blocks own the visual content, and assetIds lists their distinct IDs in order.', 'draft:write', true, { operationKey: key, brandId: id, content: contentSchema }),
  'campaign.update': descriptor('Save the exact expected revision. Preserve the full document when editing a Studio draft. Reuse the operation key only for an identical retry.', 'draft:write', true, { operationKey: key, id, expectedVersion: z.number().int().positive(), content: contentSchema }),
  'campaign.preflight': descriptor('Report all preparation and delivery gaps together. Preview success does not establish send eligibility.', 'read', false, { id }),
  'campaign.preview': descriptor('Render escaped HTML and plain text for the exact saved draft version. Does not send.', 'read', false, { id, expectedVersion: z.number().int().positive() }),
  'asset.list': descriptor('List private images for the authorized brand.', 'read', false, { brandId: id }),
  'asset.uploadBatch': descriptor('Upload original JPEG, PNG or WebP images with per-file outcomes. Max 10 files, 5 MiB each, 20 MiB total. Names are metadata; files are never fetched from URLs.', 'assets:write', true, { operationKey: key, brandId: id, files: z.array(z.object({ itemKey: key, name: z.string().trim().min(1).max(160), base64: z.string().max(Math.ceil(limits.batchBytes / 3) * 4) }).strict()).min(1).max(limits.batchFiles).refine(files => new Set(files.map(f => f.itemKey)).size === files.length, 'Each file needs a unique item key.') }),
  'connection.list': descriptor('List scoped API/MCP connections without secrets. Owner session required.', 'owner', false, {}),
  'intake.status': descriptor('Inspect subscriber intake readiness and aggregate counts for one brand.', 'owner', false, { brandId: id }),
  'segment.list': descriptor('List named groups and counts for the current owner and brand.', 'owner', false, { brandId: audienceId }),
  'segment.create': descriptor('Create a named group in the selected brand.', 'owner', true, { brandId: audienceId, operationKey: key, name: segmentName }),
  'segment.rename': descriptor('Rename one group in the selected brand.', 'owner', true, { brandId: audienceId, operationKey: key, segmentId: audienceId, name: segmentName }),
  'segment.delete': descriptor('Delete one group and preserve its contacts and consent records.', 'owner', true, { brandId: audienceId, operationKey: key, segmentId: audienceId }),
  'segment.members': descriptor('Add or remove existing brand contacts from a group. Returns counts only.', 'owner', true, { brandId: audienceId, operationKey: key, segmentId: audienceId, action: segmentAction, emails: segmentEmails }),
  'segment.summary': descriptor('Read aggregate states for one known group in the granted brand.', 'audience:summary', false, { brandId: audienceId, segmentId: audienceId }),
  'audience.summary': descriptor('Count subscriber states for one granted brand. Returns counts only.', 'audience:summary', false, { brandId: audienceId }),
  'audience.list': descriptor('Find contacts for one brand by status or exact email. Owner session required.', 'owner', false, {
    brandId: audienceId, state: stateFilter.optional(), email: normalizedEmail.optional(),
    cursor: audienceId.optional(), limit: z.number().int().min(1).max(50).default(25),
  }),
  'audience.contact': descriptor('Read one contact and a page of its consent history. Owner session required.', 'owner', false, {
    brandId: audienceId, id: audienceId, cursor: audienceId.optional(),
  }),
  'audience.unsubscribe': descriptor('Stop marketing for this contact and brand. The contact identity makes retries idempotent. Owner session required.', 'owner', true, { brandId: audienceId, id: audienceId }),
  'intake.configure': descriptor('Enable or pause subscriber intake for one configured brand. Does not enable campaigns.', 'owner', true, { brandId: id, enabled: z.boolean(), operationKey: key }),
  'connection.create': descriptor('Issue a scoped, expiring connection. Secret is displayed once and omitted from retries. Owner session required.', 'owner', true, { operationKey: key, name: z.string().trim().min(1).max(80), scopes: z.array(z.enum(capabilities)).min(1).max(6), brandIds: z.array(id).min(1).max(5), expiresInDays: z.number().int().min(1).max(90) }),
  'connection.revoke': descriptor('Revoke a connection immediately. Owner session required.', 'owner', true, { operationKey: key, id }),
} as const;
export type CommandName = keyof typeof commands;
export const isCommand = (name: string): name is CommandName => Object.hasOwn(commands, name);
