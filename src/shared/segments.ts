import { z } from 'zod';
import type { AudienceSummary } from './audience.js';
import { normalizedEmail } from './subscriber.js';

export const segmentLimit = 50;
export const segmentBatchLimit = 250;
export const segmentName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}]+$/u);
export const segmentEmails = z.array(normalizedEmail).min(1).max(segmentBatchLimit);
export const segmentAction = z.enum(['add', 'remove']);
export type SegmentAction = z.infer<typeof segmentAction>;
export type Segment = { id: string; name: string; counts: AudienceSummary };
export type SegmentDirectory = { items: Segment[]; limit: number };
export type SegmentMembershipResult = { segmentId: string; changed: number; counts: AudienceSummary };
