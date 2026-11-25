import { z } from 'zod';

export const giftAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fund') }).strict(),
  z
    .object({
      kind: z.literal('reserve'),
      days: z.union([z.literal(15), z.literal(30), z.literal(60)]),
      products: z.union([z.literal(1), z.number().int().min(5).max(10)]),
    })
    .strict(),
  z
    .object({
      kind: z.enum([
        'timeout',
        'recover',
        'expire',
        'refund',
        'disputeOpen',
        'disputeWon',
        'disputeLost',
      ]),
    })
    .strict(),
]);
export type GiftAction = z.infer<typeof giftAction>;
export type GiftEvent = GiftAction | { kind: 'intent' | 'submit'; person: number };
export type GiftOffer = {
  person: number;
  state: 'offered' | 'pending' | 'claimed' | 'expired';
  issue: string | null;
};
export type GiftStatus = {
  currency: 'USD';
  products: string[];
  dispute: string;
  access: string;
  funded: boolean;
  available: number;
  reserved: number;
  spent: number;
  refunded: number;
  offers: GiftOffer[];
  days: number;
  day: number;
  timeout: boolean;
  closed: boolean;
  orders: number;
};
export const giftPracticeEnabled = (environment?: string) =>
  ['test', 'local', 'staging'].includes(environment ?? '');
