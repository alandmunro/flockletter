import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { SubscriberIntake, suppress } from '../subscribers/intake.js';

const feedback = z.object({
  type: z.string(),
  data: z.object({
    email_id: z.uuid(),
    tags: z.object({ flockletter_job: z.uuid().optional() }).optional(),
    bounce: z.object({ type: z.string() }).optional(),
  }),
});
export async function applyFeedback(intake: SubscriberIntake, body: Buffer, headers: Record<string, string>) {
  const b = intake.binding;
  if (b?.mode !== 'live' || !b.webhookSecret)
    throw new AppError(503, 'feedback_unavailable', 'Confirmation feedback is unavailable.');
  let verified: unknown;
  try {
    verified = new Webhook(b.webhookSecret).verify(body, headers);
  } catch {
    throw new AppError(401, 'invalid_signature', 'Invalid feedback signature.');
  }
  const type = z.object({ type: z.string() }).safeParse(verified);
  if (!type.success) throw new AppError(400, 'invalid_feedback', 'Invalid feedback.');
  if (type.data.type !== 'email.complained' && type.data.type !== 'email.bounced') return;
  const event = feedback.safeParse(verified);
  if (!event.success) throw new AppError(400, 'invalid_feedback', 'Invalid feedback.');
  const { data } = event.data;
  if (
    !data.tags?.flockletter_job ||
    (type.data.type === 'email.bounced' && data.bounce?.type !== 'Permanent')
  )
    return;
  const eventId = headers['webhook-id'];
  if (!eventId || eventId.length > 200)
    throw new AppError(400, 'invalid_feedback', 'Invalid feedback identifier.');
  await intake.db.brand(b.workspaceId, b.brandId, async (sql) => {
    await sql.query('SELECT enabled FROM subscriber_intake_settings FOR UPDATE');
    const job = (
      await sql.query(
        `SELECT o.id,o.subscriber_id,o.provider_id,t.request_event_id FROM subscriber_outbox o
      JOIN subscriber_confirmation_tokens t ON t.workspace_id=o.workspace_id AND t.brand_id=o.brand_id AND t.id=o.token_id
      WHERE o.id=$1 AND o.mode='live' AND o.first_attempt_at IS NOT NULL FOR UPDATE OF o`,
        [data.tags!.flockletter_job],
      )
    ).rows[0];
    if (!job || (job.provider_id && job.provider_id !== data.email_id))
      throw new AppError(503, 'feedback_unmapped', 'The delivery record requires reconciliation.');
    const inserted = await sql.query(
      'INSERT INTO subscriber_feedback(workspace_id,brand_id,event_id,job_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [b.workspaceId, b.brandId, eventId, job.id],
    );
    if (!inserted.rowCount) return;
    await sql.query(
      "UPDATE subscriber_outbox SET state='delivered_to_provider',provider_id=$2,error_category=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1",
      [job.id, data.email_id],
    );
    await suppress(
      sql,
      job.subscriber_id,
      job.request_event_id,
      type.data.type === 'email.complained' ? 'complained' : 'hard_bounced',
    );
  });
}
