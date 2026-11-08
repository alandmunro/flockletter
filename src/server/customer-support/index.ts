import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Webhook } from 'standardwebhooks';
import type { Database, Sql } from '../db.js';
import type { Actor } from '../service.js';
import { AppError, requireCondition } from '../errors.js';
import { supportDraft, type LocalWriter } from '../support-draft.js';
import { supportAnswer, type SupportTopic } from '../../shared/support.js';
import {
  customerSupportCommands,
  type SupportDirectory,
  type SupportTicket,
  type SupportMessage,
  type SupportState,
} from '../../shared/customer-support.js';
import type { SupportProvider, SupportSubmission } from './provider.js';

type Mode = 'off' | 'capture' | 'live';
type Options = {
  mode: Mode;
  isOwner?: (user: string, workspace: string) => Promise<boolean>;
  isOperator?: (user: string, workspace: string) => Promise<boolean>;
  writer?: LocalWriter;
  provider?: SupportProvider;
  sender?: string;
  inbound?: { workspaceId: string; address: string; webhookSecret: string };
};
type TicketRow = {
  id: string;
  subject: string;
  topic: SupportTopic;
  state: SupportState;
  version: number;
  reply_to: string | null;
  draft: string | null;
  draft_provenance: SupportTicket['draftProvenance'];
  created_at: Date;
  updated_at: Date;
  mode: 'capture' | 'live';
};
type Dispatch = {
  id: string;
  ticket_id: string;
  ticket_version: number;
  body: string;
  state: string;
  mode: 'capture' | 'live';
  attempts: number;
  provider_id: string | null;
  reason: string | null;
  created_by: string;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sensitive =
  /\b(refund|dispute|chargeback|password|credential|secret|hacked|security|privacy|delete|erasure|export|recover|lost access|unauthori[sz]ed|card number)\b/i;
const clean = (value: string) => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\r\t]/g, ''));
const reviewCode = (row: TicketRow) =>
  row.draft ? hash(JSON.stringify([row.id, row.version, row.draft, row.draft_provenance])) : null;

export class CustomerSupport {
  constructor(
    readonly db: Database,
    readonly options: Options = { mode: 'off' },
  ) {}
  private async owner(actor: Actor) {
    requireCondition(
      actor.kind === 'session' && actor.owner,
      403,
      'owner_required',
      'Use the current workspace owner session.',
    );
    requireCondition(
      await this.options.isOwner?.(actor.userId, actor.workspaceId),
      403,
      'owner_required',
      'Verify current workspace ownership.',
    );
    await this.db.tenant(actor.workspaceId, (sql) => this.retained(sql));
    requireCondition(
      this.options.mode !== 'off',
      503,
      'support_unavailable',
      'Support conversations are not configured.',
    );
  }
  private async retained(sql: Sql) {
    requireCondition(
      !(await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount,
      410,
      'workspace_erased',
      'This account has completed retention erasure. Restore reconciliation is required.',
    );
  }
  private async reviewer(actor: Actor) {
    if (this.options.mode === 'capture') return;
    requireCondition(
      await this.options.isOperator?.(actor.userId, actor.workspaceId),
      403,
      'support_operator_required',
      'A verified support operator must review this reply.',
    );
  }
  private async locked<T>(workspace: string, run: (sql: Sql) => Promise<T>) {
    return this.db.tenant(workspace, async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [workspace]);
      return run(sql);
    });
  }
  private async mutate<T>(
    actor: Actor,
    name: string,
    input: { operationKey: string },
    run: (sql: Sql) => Promise<T>,
  ): Promise<T> {
    return this.locked(actor.workspaceId, async (sql) => {
      const actorId = 'customer-support:' + actor.actorId,
        digest = hash(JSON.stringify([name, input]));
      const before = (
        await sql.query<{ request_hash: string; result: T }>(
          'SELECT request_hash,result FROM operations WHERE actor_id=$1 AND operation_key=$2',
          [actorId, input.operationKey],
        )
      ).rows[0];
      if (before) {
        requireCondition(
          before.request_hash === digest,
          409,
          'operation_conflict',
          'Use the original support request for this operation key.',
        );
        return before.result;
      }
      const result = await run(sql);
      await sql.query(
        'INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',
        [actor.workspaceId, actorId, input.operationKey, digest, JSON.stringify(result)],
      );
      await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action) VALUES($1,$2,$3,$4)', [
        actor.workspaceId,
        randomUUID(),
        actor.actorId,
        name,
      ]);
      return result;
    });
  }
  private async ticket(sql: Sql, id: string, version?: number) {
    const row = (
      await sql.query<TicketRow>('SELECT * FROM customer_support_tickets WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    requireCondition(row, 404, 'support_ticket_unavailable', 'This support conversation is unavailable.');
    requireCondition(
      version === undefined || row.version === version,
      409,
      'version_conflict',
      'Reload the current support conversation.',
    );
    return row;
  }
  async get(workspace: string, id: string): Promise<SupportTicket> {
    return this.db.tenant(workspace, async (sql) => {
      const row = await this.ticket(sql, id);
      const messages = (
        await sql.query<{
          id: string;
          kind: SupportMessage['kind'];
          text: string;
          provenance: string;
          created_at: Date;
        }>(
          'SELECT id,kind,text,provenance,created_at FROM customer_support_messages WHERE ticket_id=$1 ORDER BY created_at,id',
          [id],
        )
      ).rows;
      const delivery = (
        await sql.query<Dispatch>(
          'SELECT * FROM customer_support_dispatches WHERE ticket_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
          [id],
        )
      ).rows[0];
      return this.view(
        row,
        messages.map((m) => ({
          id: m.id,
          kind: m.kind,
          text: m.text,
          provenance: m.provenance,
          createdAt: m.created_at.toISOString(),
        })),
        delivery,
      );
    });
  }
  private view(row: TicketRow, messages: SupportMessage[], delivery?: Dispatch): SupportTicket {
    return {
      id: row.id,
      subject: row.subject,
      topic: row.topic,
      state: row.state,
      version: row.version,
      replyTo: row.reply_to,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      draft: row.draft,
      draftProvenance: row.draft_provenance,
      reviewCode: reviewCode(row),
      messages,
      delivery: delivery
        ? { state: delivery.state, attempts: delivery.attempts, mode: delivery.mode, reason: delivery.reason }
        : null,
    };
  }
  private async visible(actor: Actor, ticket: SupportTicket): Promise<SupportTicket> {
    if (this.options.mode === 'capture' || (await this.options.isOperator?.(actor.userId, actor.workspaceId)))
      return ticket;
    return {
      ...ticket,
      draft: null,
      draftProvenance: null,
      reviewCode: null,
      messages: ticket.messages.filter((message) => message.kind !== 'draft'),
    };
  }
  async execute(name: string, raw: unknown, actor: Actor): Promise<unknown> {
    await this.owner(actor);
    requireCondition(name in customerSupportCommands, 404, 'unknown_command', 'Unknown support action.');
    switch (name) {
      case 'support.list': {
        const { offset } = customerSupportCommands[name].schema.parse(raw);
        return this.db.tenant(actor.workspaceId, async (sql) => {
          const rows = (
            await sql.query<TicketRow>(
              'SELECT * FROM customer_support_tickets ORDER BY updated_at DESC,id LIMIT 25 OFFSET $1',
              [offset],
            )
          ).rows;
          const total = Number(
            (await sql.query('SELECT count(*) FROM customer_support_tickets')).rows[0].count,
          );
          return {
            mode: this.options.mode,
            tickets: await Promise.all(rows.map((row) => this.visible(actor, this.view(row, [])))),
            total,
            offset,
            limit: 25,
          } satisfies SupportDirectory;
        });
      }
      case 'support.get':
        return this.visible(
          actor,
          await this.get(actor.workspaceId, customerSupportCommands[name].schema.parse(raw).id),
        );
      case 'support.create': {
        const input = customerSupportCommands[name].schema.parse(raw);
        requireCondition(
          clean(input.subject) && clean(input.text),
          422,
          'invalid_support_text',
          'Use printable plain text for the support request.',
        );
        const { id } = await this.mutate(actor, name, input, async (sql) => {
          const count = Number(
            (await sql.query('SELECT count(*) FROM customer_support_tickets')).rows[0].count,
          );
          requireCondition(
            count < 500,
            422,
            'support_limit',
            'This workspace has reached its support conversation limit.',
          );
          const id = randomUUID(),
            mode = this.options.mode === 'capture' ? 'capture' : 'live';
          const state =
            sensitive.test(input.text + ' ' + input.subject) || !supportAnswer(input.topic)
              ? 'escalated'
              : 'open';
          await sql.query(
            'INSERT INTO customer_support_tickets(workspace_id,id,subject,topic,state,reply_to,requester_id,mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              actor.workspaceId,
              id,
              input.subject,
              input.topic,
              state,
              input.replyTo ?? null,
              actor.userId,
              mode,
            ],
          );
          await this.message(sql, actor.workspaceId, id, 'incoming', input.text, 'workspace-owner');
          return { id };
        });
        return this.get(actor.workspaceId, id);
      }
      case 'support.draft': {
        await this.reviewer(actor);
        const input = customerSupportCommands[name].schema.parse(raw);
        const replay = await this.db.tenant(actor.workspaceId, async (sql) => {
          const prior = (
            await sql.query<{ request_hash: string }>(
              'SELECT request_hash FROM operations WHERE actor_id=$1 AND operation_key=$2',
              ['customer-support:' + actor.actorId, input.operationKey],
            )
          ).rows[0];
          if (prior)
            requireCondition(
              prior.request_hash === hash(JSON.stringify([name, input])),
              409,
              'operation_conflict',
              'Retry the original support request.',
            );
          return !!prior;
        });
        if (replay) return this.get(actor.workspaceId, input.id);
        const before = await this.get(actor.workspaceId, input.id);
        requireCondition(
          before.version === input.expectedVersion,
          409,
          'version_conflict',
          'Reload the current support conversation.',
        );
        const guidance = supportAnswer(before.topic);
        requireCondition(
          guidance && before.state !== 'escalated' && before.state !== 'closed' && before.state !== 'queued',
          409,
          'human_handoff',
          'A human operator must handle this support request.',
        );
        let text = guidance.text,
          provenance: NonNullable<SupportTicket['draftProvenance']> = 'approved_guidance';
        if (this.options.writer) {
          const draft = await supportDraft(before.topic, this.options.writer);
          requireCondition(
            draft.kind === 'draft' && draft.draft,
            409,
            'human_handoff',
            'A human operator must handle this support request.',
          );
          text = draft.draft;
          provenance = 'ai_assisted';
        }
        await this.mutate(actor, name, input, async (sql) => {
          const row = await this.ticket(sql, input.id, input.expectedVersion);
          requireCondition(
            ['open', 'review', 'replied'].includes(row.state),
            409,
            'human_handoff',
            'The support request changed while its reply was being prepared.',
          );
          await this.saveDraft(sql, actor.workspaceId, row.id, text, provenance);
          return { id: row.id };
        });
        return this.get(actor.workspaceId, input.id);
      }
      case 'support.editDraft': {
        await this.reviewer(actor);
        const input = customerSupportCommands[name].schema.parse(raw);
        requireCondition(
          clean(input.text),
          422,
          'invalid_support_text',
          'Use printable plain text for the support reply.',
        );
        await this.mutate(actor, name, input, async (sql) => {
          const row = await this.ticket(sql, input.id, input.expectedVersion);
          requireCondition(
            ['open', 'review', 'replied', 'escalated'].includes(row.state),
            409,
            'support_state',
            'Reopen a reviewable support conversation.',
          );
          await this.saveDraft(sql, actor.workspaceId, row.id, input.text, 'human');
          return { id: row.id };
        });
        return this.get(actor.workspaceId, input.id);
      }
      case 'support.approve': {
        await this.reviewer(actor);
        const input = customerSupportCommands[name].schema.parse(raw);
        await this.mutate(actor, name, input, async (sql) => {
          const row = await this.ticket(sql, input.id, input.expectedVersion);
          requireCondition(
            row.state === 'review' && row.draft && reviewCode(row) === input.reviewCode,
            409,
            'support_review_changed',
            'Read and approve the exact current reply.',
          );
          requireCondition(
            row.mode === this.options.mode,
            409,
            'support_transport_changed',
            'The support transport changed. Prepare a fresh review.',
          );
          if (row.mode === 'live')
            requireCondition(
              this.options.provider && this.options.sender && row.reply_to,
              503,
              'support_provider_unavailable',
              'Configure and verify the support sender and reply destination.',
            );
          const count = Number(
            (await sql.query('SELECT count(*) FROM customer_support_dispatches WHERE ticket_id=$1', [row.id]))
              .rows[0].count,
          );
          requireCondition(
            count < 5,
            422,
            'support_reply_limit',
            'This conversation needs an operator review before more replies.',
          );
          await sql.query(
            'INSERT INTO customer_support_dispatches(workspace_id,id,ticket_id,ticket_version,operation_key,body,body_digest,state,mode,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [
              actor.workspaceId,
              randomUUID(),
              row.id,
              row.version,
              input.operationKey,
              row.draft,
              hash(row.draft),
              'queued',
              row.mode,
              actor.userId,
            ],
          );
          await sql.query(
            "UPDATE customer_support_tickets SET state='queued',version=version+1,updated_at=now() WHERE id=$1",
            [row.id],
          );
          return { id: row.id };
        });
        return this.process(actor, input.id);
      }
      case 'support.process': {
        await this.reviewer(actor);
        const input = customerSupportCommands[name].schema.parse(raw);
        return this.process(actor, input.id);
      }
      case 'support.escalate':
      case 'support.close': {
        const input =
          name === 'support.close'
            ? customerSupportCommands[name].schema.parse(raw)
            : customerSupportCommands[name].schema.parse(raw);
        await this.mutate(actor, name, input, async (sql) => {
          const row = await this.ticket(sql, input.id, input.expectedVersion);
          const state = name === 'support.close' ? 'closed' : 'escalated';
          await sql.query(
            "UPDATE customer_support_dispatches SET state='cancelled',reason='conversation_changed',updated_at=now() WHERE ticket_id=$1 AND state='queued' AND attempts=0",
            [row.id],
          );
          await sql.query(
            'UPDATE customer_support_tickets SET state=$2,escalation_reason=$3,version=version+1,updated_at=now() WHERE id=$1',
            [row.id, state, 'reason' in input ? input.reason : null],
          );
          return { id: row.id };
        });
        return this.visible(actor, await this.get(actor.workspaceId, input.id));
      }
    }
  }
  private async saveDraft(sql: Sql, workspace: string, id: string, text: string, provenance: string) {
    await sql.query(
      "UPDATE customer_support_tickets SET draft=$2,draft_provenance=$3,state='review',version=version+1,updated_at=now() WHERE id=$1",
      [id, text, provenance],
    );
    await this.message(sql, workspace, id, 'draft', text, provenance);
  }
  private message(
    sql: Sql,
    workspace: string,
    ticket: string,
    kind: SupportMessage['kind'],
    text: string,
    provenance: string,
  ) {
    return sql.query(
      'INSERT INTO customer_support_messages(workspace_id,id,ticket_id,kind,text,provenance) VALUES($1,$2,$3,$4,$5,$6)',
      [workspace, randomUUID(), ticket, kind, text, provenance],
    );
  }
  private async process(actor: Actor, id: string) {
    await this.owner(actor);
    await this.reviewer(actor);
    return this.processAuthorized(actor.workspaceId, id);
  }
  private async processAuthorized(workspace: string, id: string) {
    const claim = await this.locked(workspace, async (sql) => {
      if ((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount) {
        await sql.query(
          "UPDATE customer_support_dispatches SET state='cancelled',reason='workspace_erased',updated_at=now() WHERE state='queued' AND attempts=0",
        );
        return null;
      }
      const row = await this.ticket(sql, id);
      const job = (
        await sql.query<Dispatch>(
          "SELECT * FROM customer_support_dispatches WHERE ticket_id=$1 AND state IN ('queued','submitting','uncertain') ORDER BY created_at LIMIT 1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!job) return null;
      requireCondition(
        await this.options.isOwner?.(job.created_by, workspace),
        403,
        'owner_required',
        'The original reply approver no longer has workspace authority.',
      );
      if (job.mode === 'live')
        requireCondition(
          await this.options.isOperator?.(job.created_by, workspace),
          403,
          'support_operator_required',
          'The original reviewer no longer has support authority.',
        );
      if (job.state === 'queued') {
        requireCondition(
          row.state === 'queued' && job.mode === this.options.mode,
          409,
          'support_transport_changed',
          'The reviewed support transport changed.',
        );
        await sql.query(
          "UPDATE customer_support_dispatches SET state='submitting',attempts=1,updated_at=now() WHERE id=$1",
          [job.id],
        );
        return { job, row, submit: true };
      }
      return { job, row, submit: false };
    });
    if (!claim) return this.get(workspace, id);
    const { job, row, submit } = claim;
    if (job.mode === 'capture') {
      await this.finish(workspace, job, { state: 'accepted', id: 'capture-' + job.id });
      return this.get(workspace, id);
    }
    let outcome: SupportSubmission = { state: 'unknown' };
    const provider = this.options.provider;
    if (provider && this.options.sender && row.reply_to) {
      try {
        outcome = submit
          ? await provider.submit({
              operationKey: job.id,
              workspaceId: workspace,
              to: row.reply_to,
              from: this.options.sender,
              subject: 'Re: ' + row.subject,
              text: job.body,
            })
          : await provider.lookup(job.id, job.provider_id);
      } catch {
        outcome = { state: 'unknown' };
      }
    }
    await this.finish(workspace, job, outcome);
    return this.get(workspace, id);
  }
  private async finish(workspace: string, job: Dispatch, outcome: SupportSubmission) {
    await this.locked(workspace, async (sql) => {
      const current = (
        await sql.query<Dispatch>('SELECT * FROM customer_support_dispatches WHERE id=$1 FOR UPDATE', [
          job.id,
        ])
      ).rows[0];
      if (!current || current.state === 'accepted') return;
      const next = outcome.state === 'unknown' ? 'uncertain' : outcome.state;
      if (current.state !== next)
        await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action) VALUES($1,$2,$3,$4)', [
          workspace,
          randomUUID(),
          'system:support-dispatch',
          'support.reply_' + next,
        ]);
      if (outcome.state === 'accepted') {
        requireCondition(
          !current.provider_id || current.provider_id === outcome.id,
          409,
          'support_provider_mismatch',
          'The support receipt needs operator reconciliation.',
        );
        await sql.query(
          "UPDATE customer_support_dispatches SET state='accepted',provider_id=$2,reason=NULL,updated_at=now() WHERE id=$1",
          [job.id, outcome.id],
        );
        await this.message(
          sql,
          workspace,
          job.ticket_id,
          job.mode === 'capture' ? 'captured_reply' : 'sent_reply',
          job.body,
          job.mode === 'capture' ? 'captured-transport' : 'verified-provider',
        );
        await sql.query(
          "UPDATE customer_support_tickets SET state=CASE WHEN state='queued' THEN 'replied' ELSE state END,version=version+1,updated_at=now() WHERE id=$1",
          [job.ticket_id],
        );
      } else
        await sql.query(
          'UPDATE customer_support_dispatches SET state=$2,reason=$3,updated_at=now() WHERE id=$1',
          [
            job.id,
            outcome.state === 'rejected' ? 'rejected' : 'uncertain',
            outcome.state === 'rejected' ? 'provider_rejected' : 'provider_unknown',
          ],
        );
    });
  }
  async tickWorkspace(workspace: string) {
    if (this.options.mode === 'off') return { processed: 0 };
    const jobs = await this.db.tenant(
      workspace,
      async (sql) =>
        (
          await sql.query<{ ticket_id: string; created_by: string }>(
            "SELECT DISTINCT ticket_id,created_by FROM customer_support_dispatches WHERE state IN ('queued','submitting','uncertain') LIMIT 25",
          )
        ).rows,
    );
    let processed = 0;
    for (const job of jobs) {
      if (!(await this.options.isOwner?.(job.created_by, workspace))) continue;
      if (this.options.mode === 'live' && !(await this.options.isOperator?.(job.created_by, workspace)))
        continue;
      await this.processAuthorized(workspace, job.ticket_id);
      processed++;
    }
    return { processed };
  }
  /** Worker entry point; its caller must supply a current, independently verified operator actor. */
  async tick(actor: Actor) {
    await this.owner(actor);
    await this.reviewer(actor);
    const jobs = await this.db.tenant(
      actor.workspaceId,
      async (sql) =>
        (
          await sql.query<{ ticket_id: string }>(
            "SELECT DISTINCT ticket_id FROM customer_support_dispatches WHERE state IN ('queued','submitting','uncertain') LIMIT 25",
          )
        ).rows,
    );
    for (const job of jobs) await this.process(actor, job.ticket_id);
    return { processed: jobs.length };
  }
  async receiveSigned(body: Buffer, headers: Record<string, string>) {
    requireCondition(
      body.length <= 16384,
      413,
      'support_email_too_large',
      'Support email exceeds the intake limit.',
    );
    const binding = this.options.inbound;
    requireCondition(
      this.options.mode === 'live' && binding,
      503,
      'support_inbound_unavailable',
      'Support email intake is unavailable.',
    );
    let verified: unknown;
    try {
      verified = new Webhook(binding.webhookSecret).verify(body, headers);
    } catch {
      throw new AppError(401, 'invalid_signature', 'Invalid support email signature.');
    }
    const envelope = z
      .object({
        id: z.string().min(1).max(200),
        to: z.array(z.email()).length(1),
        from: z.email().max(254),
        subject: z.string().min(1).max(160),
        text: z.string().min(1).max(8000),
        autoSubmitted: z.enum(['no', 'auto-replied', 'auto-generated']),
      })
      .strict()
      .parse(verified);
    requireCondition(
      envelope.to[0] === binding.address && clean(envelope.subject) && clean(envelope.text),
      422,
      'invalid_support_email',
      'The support email does not match its configured destination.',
    );
    return this.locked(binding.workspaceId, async (sql) => {
      await this.retained(sql);
      const fingerprint = hash(body.toString('utf8'));
      const old = (
        await sql.query<{ digest: string; ticket_id: string | null }>(
          'SELECT digest,ticket_id FROM customer_support_events WHERE event_id=$1',
          [envelope.id],
        )
      ).rows[0];
      if (old) {
        requireCondition(
          old.digest === fingerprint,
          409,
          'support_event_conflict',
          'The support message identifier was reused.',
        );
        return { id: old.ticket_id };
      }
      const totals = (
        await sql.query(
          'SELECT (SELECT count(*) FROM customer_support_tickets) tickets,(SELECT count(*) FROM customer_support_events) events',
        )
      ).rows[0];
      requireCondition(
        Number(totals.events) < 5000 && Number(totals.tickets) < 500,
        429,
        'support_limit',
        'Support email intake needs operator review.',
      );
      let id: string | null = null;
      if (envelope.autoSubmitted === 'no') {
        id = randomUUID();
        await sql.query(
          "INSERT INTO customer_support_tickets(workspace_id,id,subject,topic,state,reply_to,requester_id,mode) VALUES($1,$2,$3,'other','escalated',$4,'signed-inbound','live')",
          [binding.workspaceId, id, envelope.subject, envelope.from],
        );
        await this.message(sql, binding.workspaceId, id, 'incoming', envelope.text, 'signed-inbound');
      }
      await sql.query(
        'INSERT INTO customer_support_events(workspace_id,event_id,digest,ticket_id) VALUES($1,$2,$3,$4)',
        [binding.workspaceId, envelope.id, fingerprint, id],
      );
      return { id };
    });
  }
}
