import type { DeliveryRow } from './types.js';
import type { DeliveryView } from '../../shared/customer-delivery.js';

export type DeliveryGroupRow = {
  workspace_id: string;
  brand_id: string;
  delivery_id: string;
  state: string;
  feedback: string | null;
  n: number;
};

export type DeliveryRecipientRow = {
  workspace_id: string;
  brand_id: string;
  delivery_id: string;
  id: string;
  state: string;
  feedback: string | null;
  reason: string | null;
  attempts: number;
};

type DeliveryKey=string;
const deliveryKey=(workspaceId:string,brandId:string,deliveryId:string):DeliveryKey=>JSON.stringify([workspaceId,brandId,deliveryId]);

function countStates(groups: DeliveryGroupRow[], ...states: string[]): number {
  return groups.filter(g => states.includes(g.state)).reduce((n, g) => n + g.n, 0);
}

function countFeedback(groups: DeliveryGroupRow[], kind: string): number {
  return groups.filter(g => g.feedback === kind).reduce((n, g) => n + g.n, 0);
}

export function mapDeliveryViews(
  rows: DeliveryRow[],
  groups: DeliveryGroupRow[],
  recipients: DeliveryRecipientRow[]
): DeliveryView[] {
  if (rows.length === 0) return [];

  const groupByDelivery = new Map<DeliveryKey, DeliveryGroupRow[]>();
  for (const g of groups) {
    const key = deliveryKey(g.workspace_id, g.brand_id, g.delivery_id);
    const existing = groupByDelivery.get(key) ?? [];
    existing.push(g);
    groupByDelivery.set(key, existing);
  }

  const recipientsByDelivery = new Map<DeliveryKey, DeliveryRecipientRow[]>();
  for (const r of recipients) {
    const key = deliveryKey(r.workspace_id, r.brand_id, r.delivery_id);
    const existing = recipientsByDelivery.get(key) ?? [];
    existing.push(r);
    recipientsByDelivery.set(key, existing);
  }

  return rows.map(row => {
    const key = deliveryKey(row.workspace_id, row.brand_id, row.id);
    const dGroups = groupByDelivery.get(key) ?? [];
    const dRecipients = (recipientsByDelivery.get(key) ?? []).map(r => ({
      id: r.id,
      state: r.state,
      feedback: r.feedback,
      reason: r.reason,
      attempts: r.attempts,
    }));

    return {
      id: row.id,
      brandId: row.brand_id,
      campaignId: row.campaign_id,
      version: row.version,
      subject: row.content.subject,
      senderProfile: row.sender_profile,
      state: row.state,
      mode: row.mode,
      dueAt: row.due_at.toISOString(),
      selected: row.selected,
      excluded: row.excluded,
      pending: countStates(dGroups, 'pending', 'prepared'),
      preparing: countStates(dGroups, 'preparing'),
      submitting: countStates(dGroups, 'submitting'),
      accepted: countStates(dGroups, 'accepted'),
      uncertain: countStates(dGroups, 'uncertain'),
      rejected: countStates(dGroups, 'rejected'),
      skipped: countStates(dGroups, 'excluded', 'cancelled'),
      delivered: countFeedback(dGroups, 'delivered'),
      hardBounced: countFeedback(dGroups, 'hard_bounce'),
      complained: countFeedback(dGroups, 'complaint'),
      createdAt: row.created_at.toISOString(),
      reason: row.reason,
      recipients: dRecipients,
    };
  });
}
