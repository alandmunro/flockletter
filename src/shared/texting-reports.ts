import { z } from 'zod';
const companyId = z.uuid();
const cursor = z.uuid().optional();
export const textingReportCommands = {
  'sms.practiceReport': { description: 'Read captured send outcomes by company and creation date in UTC. Returns up to 100 campaigns at a time.', scope: 'read', mutation: false,
    schema: z.strictObject({ companyId, from: z.iso.date(), through: z.iso.date(), cursor }).refine(({ from, through }) => from <= through && Date.parse(through) - Date.parse(from) <= 365 * 86400000, 'Choose a range of up to 366 calendar days.') },
  'sms.practiceRecipients': { description: 'Read one staged campaign’s actual recipient outcomes in a current workspace owner session.', scope: 'owner', mutation: false,
    schema: z.strictObject({ companyId, sendId: z.uuid(), cursor }) },
} as const;
export type PracticeReportCommand = keyof typeof textingReportCommands;
export type DeliveryCounts = { recipients: number; carrierReceipts: number; delivered: number; failed: number; pending: number; held: number; uncertain: number; skipped: number; cancelled: number; receiptSegments: number };
export type CampaignResult = DeliveryCounts & { id: string; created: string; state: string; kind: string };
export type PracticeReport = { totals: DeliveryCounts; campaigns: CampaignResult[]; next: string | null };
export type RecipientResult = { id: string; phone: string; state: string; reason: string | null; segments: number; attempts: number; updated: string };
export type RecipientReport = { recipients: RecipientResult[]; next: string | null };
