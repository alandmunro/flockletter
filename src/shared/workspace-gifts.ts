import { z } from 'zod';
import { commandDefinition as command } from './command-definition.js';

const brandId = z.uuid(),
  operationKey = z.uuid();
const face = z.number().int().min(1).max(10000000);
export const workspaceGiftCommands = {
  'gifts.status': command('Read gift balances and results for the selected brand.', 'read', false, {
    brandId,
  }),
  'gifts.notificationPreferences': command(
    'Change optional workspace-owner gift alerts for email and in-app delivery.',
    'owner',
    true,
    {
      brandId,
      operationKey,
      lowCredit: z.boolean(),
      campaignEnded: z.boolean(),
    },
  ),
  'gifts.catalog': command(
    'List eligible provider products at the selected USD value.',
    'owner',
    false,
    {
      brandId,
      face,
    },
  ),
  'gifts.purchase': command(
    'Prepare or recover hosted checkout for USD gift credit including the purchase fee.',
    'owner',
    true,
    { brandId, operationKey, face: face.min(100) },
  ),
  'gifts.reconcile': command(
    'Retrieve a gift purchase from Stripe and post verified credit.',
    'owner',
    true,
    { brandId, operationKey, purchaseId: z.uuid() },
  ),
  'gifts.launch': command('Reserve gift offers for eligible contacts in this brand.', 'owner', true, {
    brandId,
    operationKey,
    title: z.string().trim().min(1).max(100),
    face,
    days: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    products: z
      .array(z.string().regex(/^[A-Z0-9]{4,20}$/))
      .max(10)
      .refine((xs) => xs.length === 1 || xs.length >= 5),
    personIds: z.array(z.uuid()).min(1).max(1000),
    brokerConfirmed: z.boolean(),
  }),
  'gifts.close': command(
    'Close workspace gifting and reconcile refunds of unused credit.',
    'owner',
    true,
    {
      brandId,
      operationKey,
    },
  ),
  'gifts.link': command('Retrieve the existing claim link for one funded recipient.', 'owner', false, {
    brandId,
    campaignId: z.uuid(),
    personId: z.uuid(),
  }),
};
export type WorkspaceGiftCommand = keyof typeof workspaceGiftCommands;

export type GiftAlertPreferences = { lowCredit: boolean; campaignEnded: boolean };
export type GiftNoticeSummary = {
  id: string;
  message: string;
  at: string;
  email: 'queued' | 'captured' | 'accepted' | 'review' | 'suppressed';
};
export type GiftNotificationView = { preferences: GiftAlertPreferences; notices: GiftNoticeSummary[] };
