export type RehearsalAlertKind = 'overdue' | 'uncertain' | 'blocked' | 'held' | 'hard_bounce' | 'complaint';
export const alertGuidance: Record<RehearsalAlertKind, {title: string; action: string}> = {
  overdue: {title:'Overdue queued rehearsals',action:'Open the affected campaign and refresh its rehearsals after staging wakes.'},
  uncertain: {title:'Receipts to reconcile',action:'Check the provider status on the original rehearsal. Keep its allowance reserved while the outcome is uncertain.'},
  blocked: {title:'Blocked rehearsals',action:'Read the block reason and resolve it before reviewing the campaign again.'},
  held: {title:'Held rehearsal reservations',action:'Check the original rehearsal for outstanding provider receipts. The worker settles its reservation when the outcome is known.'},
  hard_bounce: {title:'Recorded hard bounces',action:'Review the recipient outcomes and keep affected addresses suppressed.'},
  complaint: {title:'Recorded complaints',action:'Review this brand’s consent source and preserve complaint suppressions.'},
};
export type RehearsalAlert = {
  kind: RehearsalAlertKind; count: number; brandId: string; brandName: string;
  campaignId: string; rehearsalId: string; version: number; nextAction: string;
};
export type WorkspaceActivity = {
  events: { id: string; action: string; actor: string; at: string }[];
  captures: { queued: number; blocked: number; captured: number; overdue: number };
  emailDelivery: 'off';
  checkedAt: string;
  alerts: RehearsalAlert[];
};
