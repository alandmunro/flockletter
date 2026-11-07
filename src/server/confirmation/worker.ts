import { randomUUID, randomInt } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { fingerprint, type IntakeBinding } from '../subscribers/config.js';
import { actionToken, actionUrl, hash } from '../subscribers/tokens.js';
import type { ConfirmationMessage, ConfirmationProvider, DispatchOutcome } from './provider.js';

type Job = {
  id: string;
  subscriber_id: string;
  token_id: string;
  unsubscribe_id: string;
  mode: string;
  attempts: number;
  uncertain: boolean;
  state: string;
  payload_digest: string | null;
  outside_window: boolean;
  email_normalized: string;
  subscriber_state: string;
  token_hash: string;
  unsubscribe_hash: string;
  usable: boolean;
  issuer_id: string;
  grant_valid: boolean;
};
const projection = `SELECT o.*,s.email_normalized,s.state AS subscriber_state,t.token_hash,u.token_hash AS unsubscribe_hash,
  c.issuer_id,c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND c.scopes=ARRAY['subscriber:signup']::text[]
    AND c.brand_ids=ARRAY[o.brand_id] AS grant_valid,
  t.consumed_at IS NULL AND t.expires_at>clock_timestamp() AS usable,
  o.first_attempt_at < clock_timestamp()-interval '23 hours' AS outside_window FROM subscriber_outbox o
  JOIN subscribers s ON s.workspace_id=o.workspace_id AND s.brand_id=o.brand_id AND s.id=o.subscriber_id
  JOIN connections c ON c.workspace_id=o.workspace_id AND c.id=o.connection_id
  JOIN subscriber_confirmation_tokens t ON t.workspace_id=o.workspace_id AND t.brand_id=o.brand_id AND t.id=o.token_id
  JOIN subscriber_confirmation_tokens u ON u.workspace_id=o.workspace_id AND u.brand_id=o.brand_id AND u.id=o.unsubscribe_id`;

export class ConfirmationWorker {
  constructor(
    readonly db: Database,
    readonly binding: IntakeBinding,
    readonly provider: ConfirmationProvider,
    private readonly isOwner: (issuer: string, workspace: string) => Promise<boolean>,
  ) {
    if (binding.mode !== provider.mode) throw new Error('Confirmation transport and brand mode must match.');
  }
  private tx<T>(fn: (sql: Sql) => Promise<T>) {
    return this.db.brand(this.binding.workspaceId, this.binding.brandId, fn);
  }
  private async issuerActive(issuer: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Membership lookup timed out.')), 5000);
      });
      return await Promise.race([this.isOwner(issuer, this.binding.workspaceId), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
  private envelope(job: Job): ConfirmationMessage | undefined {
    const b = this.binding;
    if (
      !job.grant_valid ||
      job.mode !== b.mode ||
      job.subscriber_state !== 'pending' ||
      !job.usable ||
      !b.recipients.has(job.email_normalized) ||
      job.token_hash !== hash(actionToken(b, 'confirm', job.token_id)) ||
      job.unsubscribe_hash !== hash(actionToken(b, 'unsubscribe', job.unsubscribe_id))
    )
      return;
    return {
      to: job.email_normalized,
      from: b.sender,
      confirm: actionUrl(b, 'confirm', job.token_id),
      unsubscribe: actionUrl(b, 'unsubscribe', job.unsubscribe_id),
    };
  }
  private async finish(
    sql: Sql,
    id: string,
    state: string,
    category: string | null,
    providerId: string | null = null,
  ) {
    await sql.query(
      'UPDATE subscriber_outbox SET state=$2,error_category=$3,provider_id=coalesce($4,provider_id),lease_id=NULL,lease_until=NULL WHERE id=$1',
      [id, state, category, providerId],
    );
  }
  async tick() {
    const b = this.binding;
    const lease = randomUUID();
    const id = await this.tx(async (sql) => {
      const g = (
        await sql.query(
          `INSERT INTO subscriber_intake_settings(workspace_id,brand_id,heartbeat_at,worker_mode,worker_fingerprint)
        SELECT $1,$2,now(),$3,$4 FROM brands WHERE workspace_id=$1 AND id=$2 ON CONFLICT(workspace_id,brand_id)
        DO UPDATE SET heartbeat_at=now(),worker_mode=excluded.worker_mode,worker_fingerprint=excluded.worker_fingerprint RETURNING enabled`,
          [b.workspaceId, b.brandId, b.mode, fingerprint(b)],
        )
      ).rows[0];
      if (!g?.enabled) return;
      const job = (
        await sql.query<Job>(
          projection +
            ` WHERE (o.state='pending' AND o.next_attempt_at<=clock_timestamp())
        OR (o.state='leased' AND o.lease_until<clock_timestamp()) ORDER BY o.next_attempt_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
        )
      ).rows[0];
      if (!job) return;
      const uncertain = job.uncertain || job.state === 'leased';
      const msg = this.envelope(job);
      if (
        !msg ||
        job.outside_window ||
        job.attempts >= 6 ||
        (job.payload_digest && job.payload_digest !== hash(JSON.stringify(msg)))
      ) {
        await this.finish(
          sql,
          job.id,
          uncertain ? 'unknown' : !msg ? 'cancelled' : 'failed',
          uncertain ? 'reconciliation_required' : 'ineligible',
        );
        return;
      }
      await sql.query(
        `UPDATE subscriber_outbox SET state='leased',attempts=attempts+1,lease_id=$2,lease_until=now()+interval '60 seconds',
        first_attempt_at=coalesce(first_attempt_at,now()),payload_digest=$3,uncertain=$4 WHERE id=$1`,
        [job.id, lease, hash(JSON.stringify(msg)), uncertain],
      );
      return job.id;
    });
    if (!id) return false;

    // Intent and immutable payload digest are committed before a provider can see the operation.
    await this.tx(async (sql) => {
      const gate = (
        await sql.query('SELECT enabled,worker_fingerprint FROM subscriber_intake_settings FOR SHARE')
      ).rows[0];
      const job = (
        await sql.query<Job>(
          projection +
            " WHERE o.id=$1 AND o.state='leased' AND o.lease_id=$2 FOR UPDATE OF s,o FOR SHARE OF c",
          [id, lease],
        )
      ).rows[0];
      if (!job) return;
      const msg = this.envelope(job);
      if (
        !gate?.enabled ||
        gate.worker_fingerprint !== fingerprint(b) ||
        !msg ||
        hash(JSON.stringify(msg)) !== job.payload_digest
      ) {
        await this.finish(sql, id, job.uncertain ? 'unknown' : 'cancelled', 'ineligible');
        return;
      }
      let outcome: DispatchOutcome;
      let issuerActive: boolean;
      try {
        issuerActive = await this.issuerActive(job.issuer_id);
      } catch {
        if (job.attempts >= 6)
          await this.finish(sql, id, job.uncertain ? 'unknown' : 'failed', 'membership_unavailable');
        else
          await sql.query(
            "UPDATE subscriber_outbox SET state='pending',lease_id=NULL,lease_until=NULL,error_category='membership_unavailable',next_attempt_at=now()+interval '1 minute' WHERE id=$1",
            [id],
          );
        return;
      }
      if (!issuerActive) {
        await this.finish(sql, id, job.uncertain ? 'unknown' : 'cancelled', 'issuer_revoked');
        return;
      }
      try {
        outcome = await this.provider.deliver(id, msg);
      } catch {
        outcome = { kind: 'ambiguous' };
      }
      if (outcome.kind === 'accepted' || outcome.kind === 'captured') {
        if ((outcome.kind === 'captured') !== (b.mode === 'capture')) {
          await this.finish(sql, id, 'unknown', 'transport_mismatch');
          return;
        }
        await this.finish(
          sql,
          id,
          outcome.kind === 'accepted' ? 'delivered_to_provider' : 'captured',
          null,
          outcome.id,
        );
        return;
      }
      const uncertain = job.uncertain || outcome.kind === 'ambiguous' || outcome.kind === 'conflict';
      if (outcome.kind === 'rejected' || outcome.kind === 'conflict' || job.attempts >= 6) {
        await this.finish(
          sql,
          id,
          uncertain ? 'unknown' : 'failed',
          uncertain ? 'reconciliation_required' : 'provider_rejected',
        );
        return;
      }
      const delay = Math.min(3600, 30 * 2 ** (job.attempts - 1)) + randomInt(16);
      await sql.query(
        `UPDATE subscriber_outbox SET state='pending',lease_id=NULL,lease_until=NULL,uncertain=$2,
        error_category=$3,next_attempt_at=now()+($4::int*interval '1 second') WHERE id=$1`,
        [id, uncertain, uncertain ? 'provider_uncertain' : 'provider_busy', delay],
      );
    });
    return true;
  }
  async alerts() {
    return this.tx(
      async (sql) =>
        (
          await sql.query(`SELECT count(*) FILTER(WHERE state IN ('pending','leased') AND created_at<now()-interval '15 minutes')::int AS backlog,
      count(*) FILTER(WHERE state IN ('failed','unknown'))::int AS unresolved,
      count(*) FILTER(WHERE state='pending' AND error_category='provider_uncertain')::int AS provider_errors FROM subscriber_outbox`)
        ).rows[0]!,
    );
  }
}
