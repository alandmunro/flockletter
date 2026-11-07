import { z } from 'zod';

export type { IntakeStatus } from './subscriber.js';
export const capabilities = ['read', 'draft:write', 'assets:write', 'subscriber:signup'] as const;
export type Capability = typeof capabilities[number];
export const limits = { fileBytes: 5 * 1024 * 1024, batchBytes: 20 * 1024 * 1024, batchFiles: 10, imagePixels: 25_000_000, campaignImages: 6, workspaceBytes: 100 * 1024 * 1024, assets: 500, drafts: 100, connections: 10, preparationOperations: 2000 } as const;
export const plans = [
  { id: 'starter', name: 'Starter', currency: 'USD', priceMinor: 1500, contacts: 2500, recipients: 2500, campaigns: 2, emails: 5000, companies: 1, brands: 1, users: 1 },
  { id: 'growth', name: 'Growth', currency: 'USD', priceMinor: 2500, contacts: 5000, recipients: 5000, campaigns: 5, emails: 25000, companies: 3, brands: 3, users: 3 },
  { id: 'pro', name: 'Pro', currency: 'USD', priceMinor: 3900, contacts: 10000, recipients: 10000, campaigns: 20, emails: 100000, companies: 5, brands: 5, users: null },
] as const;
export const contentSchema = z.object({
  title: z.string().trim().max(120), subject: z.string().trim().max(150), preheader: z.string().trim().max(200),
  fromName: z.string().trim().max(100), replyTo: z.string().trim().max(254), heading: z.string().trim().max(150),
  body: z.string().max(12000), ctaLabel: z.string().trim().max(60), ctaUrl: z.string().trim().max(2048),
  assetIds: z.array(z.uuid()).max(limits.campaignImages).refine(ids => new Set(ids).size === ids.length, 'Choose each image once.'),
}).strict();
export type CampaignContent = z.infer<typeof contentSchema>;
export const emptyContent = (): CampaignContent => ({ title: '', subject: '', preheader: '', fromName: '', replyTo: '', heading: '', body: '', ctaLabel: '', ctaUrl: '', assetIds: [] });
export type AssetSummary = { id: string; name: string; mime: string; size: number; width: number; height: number; sha256: string; createdAt: string };
export type Campaign = { id: string; brandId: string; version: number; content: CampaignContent; createdAt: string; updatedAt: string; status: 'draft' };
export type Brand = { id: string; name: string };
export type Workspace = { name: string; brands: Brand[]; entitlement: 'not_activated'; canManageConnections: boolean; preparationLimits: typeof limits; plans: typeof plans };
export type Gap = { code: string; title: string; detail: string; area: 'content' | 'sender' | 'audience' | 'billing' | 'delivery' };
export type Preflight = { campaignId: string; version: number; canSend: false; contentReady: boolean; gaps: Gap[] };
export type Connection = { id: string; name: string; scopes: Capability[]; brandIds: string[]; createdAt: string; expiresAt: string; revokedAt: string | null };

const key = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'Use a stable operation key of 16–128 letters, digits, dashes or underscores.');
const id = z.uuid();
const descriptor = <T extends z.ZodRawShape>(description: string, scope: Capability | 'owner', mutation: boolean, shape: T) => ({ description, scope, mutation, schema: z.object(shape).strict() });
export const commands = {
  'workspace.get': descriptor('Inspect workspace, plan catalogue and preparation limits. Does not create records.', 'read', false, {}),
  'workspace.preflight': descriptor('Start here: inspect all workspace setup gaps and preparation limits before gathering content or photos. Never starts billing or sends.', 'read', false, {}),
  'workspace.initialize': descriptor('Create the current Clerk organization workspace and first brand once. Does not activate a subscription.', 'owner', true, { operationKey: key, name: z.string().trim().min(1).max(100), brandName: z.string().trim().min(1).max(100) }),
  'campaign.list': descriptor('List accessible draft campaigns, newest first.', 'read', false, {}),
  'campaign.get': descriptor('Read one authorized draft version.', 'read', false, { id }),
  'campaign.create': descriptor('Prepare a draft in an authorized brand. No sending or recipient changes.', 'draft:write', true, { operationKey: key, brandId: id, content: contentSchema }),
  'campaign.update': descriptor('Save a draft only if its expected version still matches. Reuse the operation key only for an identical retry.', 'draft:write', true, { operationKey: key, id, expectedVersion: z.number().int().positive(), content: contentSchema }),
  'campaign.preflight': descriptor('Report all preparation and delivery gaps together. Preview success does not establish send eligibility.', 'read', false, { id }),
  'campaign.preview': descriptor('Render escaped HTML and plain text for the exact saved draft version. Does not send.', 'read', false, { id, expectedVersion: z.number().int().positive() }),
  'asset.list': descriptor('List private images for the authorized brand.', 'read', false, { brandId: id }),
  'asset.uploadBatch': descriptor('Upload original JPEG, PNG or WebP images with per-file outcomes. Max 10 files, 5 MiB each, 20 MiB total. Names are metadata; files are never fetched from URLs.', 'assets:write', true, { operationKey: key, brandId: id, files: z.array(z.object({ itemKey: key, name: z.string().trim().min(1).max(160), base64: z.string().max(Math.ceil(limits.batchBytes / 3) * 4) }).strict()).min(1).max(limits.batchFiles).refine(files => new Set(files.map(f => f.itemKey)).size === files.length, 'Each file needs a unique item key.') }),
  'connection.list': descriptor('List scoped API/MCP connections without secrets. Owner session required.', 'owner', false, {}),
  'intake.status': descriptor('Inspect subscriber intake readiness and aggregate counts for one brand.', 'owner', false, { brandId: id }),
  'intake.configure': descriptor('Enable or pause subscriber intake for one configured brand. Does not enable campaigns.', 'owner', true, { brandId: id, enabled: z.boolean(), operationKey: key }),
  'connection.create': descriptor('Issue a scoped, expiring connection. Secret is displayed once and omitted from retries. Owner session required.', 'owner', true, { operationKey: key, name: z.string().trim().min(1).max(80), scopes: z.array(z.enum(capabilities)).min(1).max(3), brandIds: z.array(id).min(1).max(5), expiresInDays: z.number().int().min(1).max(90) }),
  'connection.revoke': descriptor('Revoke a connection immediately. Owner session required.', 'owner', true, { operationKey: key, id }),
} as const;
export type CommandName = keyof typeof commands;
export const isCommand = (name: string): name is CommandName => Object.hasOwn(commands, name);
