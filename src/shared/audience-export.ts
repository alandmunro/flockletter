import { z } from 'zod';
import type { AudienceContact } from './audience.js';

export const exportLimits = { page: 500, contacts: 10_000 } as const;
export const exportPageInput = z
  .object({
    brandId: z.uuid().toLowerCase(),
    cursor: z.uuid().toLowerCase().optional(),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type ExportPageInput = z.infer<typeof exportPageInput>;
export type ExportContact = Pick<AudienceContact, 'email' | 'state' | 'createdAt' | 'confirmedAt'>;
export type ExportPage = {
  rows: ExportContact[];
  total: number;
  revision: string;
  nextCursor: string | null;
};
