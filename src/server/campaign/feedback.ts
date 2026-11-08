import { z } from 'zod';
import { digest } from '../content.js';
import { AppError } from '../errors.js';
import type { Sql } from '../db.js';
import type { CampaignFeedbackKind } from '../../shared/rehearsal.js';
import { practiceMailbox } from '../../shared/rehearsal.js';
import { suppress } from '../subscribers/intake.js';
import { settleReservation } from './rehearsal.js';
import { simulatorDestination } from './ses-simulator.js';

export const localFeedbackBinding = 'local-feedback-v1';
type FeedbackInput = {
  workspace: string;
  brand: string;
  operation: string;
  eventId: string;
  messageId: string;
  transport: 'feedback_test' | 'ses_simulator' | 'listmonk_test' | 'listmonk_ses';
  binding: string;
  kind: CampaignFeedbackKind;
  destination: string;
};
const unmapped = () =>
  new AppError(409, 'feedback_unmapped', 'The provider event does not match an attempted delivery.');
export async function saveProviderReceipt(
  sql: Sql,
  workspace: string,
  brand: string,
  rehearsal: string,
  operation: string,
  binding: string,
  messageId: string,
) {
  await sql.query(
    `INSERT INTO campaign_provider_receipts(workspace_id,brand_id,rehearsal_id,operation_key,provider_binding,message_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [workspace, brand, rehearsal, operation, binding, messageId],
  );
  const receipt = (
    await sql.query<{ matched: boolean }>(
      'SELECT message_id=$3 AND provider_binding=$4 matched FROM campaign_provider_receipts WHERE operation_key=$1 AND rehearsal_id=$2',
      [operation, rehearsal, messageId, binding],
    )
  ).rows[0];
  if (!receipt?.matched) throw unmapped();
}
// Only the internal rehearsal provider or the verified, pinned SNS subscription calls this function.
export async function recordCampaignFeedback(sql: Sql, input: FeedbackInput) {
  if (
    !z.uuid().safeParse(input.operation).success ||
    !input.eventId ||
    input.eventId.length > 200 ||
    !input.messageId ||
    input.messageId.length > 256
  )
    throw unmapped();
  const local = input.transport === 'feedback_test' || input.transport === 'listmonk_test';
  if (local && input.messageId !== 'local-' + input.operation) throw unmapped();
  await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.workspace]);
  await sql.query('SELECT enabled FROM subscriber_intake_settings FOR UPDATE');
  const p = (
    await sql.query<{
      rehearsal_id: string;
      subscriber_id: string | null;
      email_digest: string | null;
      audience: string;
    }>(
      `SELECT p.rehearsal_id,p.subscriber_id,p.email_digest,r.audience FROM rehearsal_recipients p
    JOIN campaign_rehearsals r ON (r.workspace_id,r.brand_id,r.id)=(p.workspace_id,p.brand_id,p.rehearsal_id)
    WHERE p.workspace_id=$1 AND p.brand_id=$2 AND p.id=$3 AND r.transport=$4 AND r.provider_binding=$5
    AND p.attempts>0 AND p.state IN ('submitting','uncertain','accepted') FOR UPDATE OF p`,
      [input.workspace, input.brand, input.operation, input.transport, input.binding],
    )
  ).rows[0];
  if (!p) throw unmapped();
  // Compare to the reviewed address digest. Never use an event-supplied address to find a contact.
  const alias =
    local
      ? input.destination
      : [practiceMailbox, 'bounce@delivery.test', 'complaint@delivery.test'].find(
          (v) => simulatorDestination(v) === input.destination,
        );
  if (
    !alias ||
    (p.subscriber_id ? digest(alias) !== p.email_digest : p.audience !== 'test' || alias !== practiceMailbox)
  )
    throw unmapped();
  await saveProviderReceipt(
    sql,
    input.workspace,
    input.brand,
    p.rehearsal_id,
    input.operation,
    input.binding,
    input.messageId,
  );
  const entry = await sql.query(
    `INSERT INTO campaign_provider_events(workspace_id,brand_id,operation_key,event_id,kind)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [input.workspace, input.brand, input.operation, input.eventId, input.kind],
  );
  if (!entry.rowCount) {
    const same = await sql.query(
      'SELECT 1 FROM campaign_provider_events WHERE event_id=$1 AND operation_key=$2 AND kind=$3',
      [input.eventId, input.operation, input.kind],
    );
    if (!same.rowCount)
      throw new AppError(
        409,
        'feedback_conflict',
        'This provider event was already recorded with different facts.',
      );
    return;
  }
  if (p.subscriber_id && (input.kind === 'permanent_bounce' || input.kind === 'complaint')) {
    const contact = await sql.query('SELECT email_normalized FROM subscribers WHERE id=$1 FOR UPDATE', [
      p.subscriber_id,
    ]);
    if (contact.rows[0] && digest(contact.rows[0].email_normalized) === p.email_digest) {
      const evidence = (
        await sql.query(
          "SELECT id FROM subscriber_consent_events WHERE subscriber_id=$1 AND event='signup_requested' ORDER BY recorded_at DESC,id DESC LIMIT 1",
          [p.subscriber_id],
        )
      ).rows[0];
      await suppress(
        sql,
        p.subscriber_id,
        evidence?.id ?? null,
        input.kind === 'complaint' ? 'complained' : 'hard_bounced',
        'campaign-' + input.transport,
      );
    }
  }
  // Signed feedback may be the first positive receipt after a lost SendEmail acknowledgement.
  await sql.query(
    "UPDATE rehearsal_recipients SET state='accepted',reason=NULL,next_check_at=NULL WHERE id=$1 AND rehearsal_id=$2 AND state IN ('submitting','uncertain')",
    [input.operation, p.rehearsal_id],
  );
  await settleReservation(sql, p.rehearsal_id);
  await sql.query(
    `UPDATE campaign_rehearsals SET state='completed',finished_at=now() WHERE id=$1 AND state='queued'
    AND NOT EXISTS (SELECT FROM rehearsal_recipients WHERE rehearsal_id=$1 AND state IN ('pending','submitting','uncertain'))`,
    [p.rehearsal_id],
  );
}
export function localFeedbackKind(alias: string): CampaignFeedbackKind {
  if (alias === 'bounce@delivery.test') return 'permanent_bounce';
  if (alias === 'complaint@delivery.test') return 'complaint';
  if (alias === 'delay@delivery.test') return 'temporary_bounce';
  return 'delivered';
}
