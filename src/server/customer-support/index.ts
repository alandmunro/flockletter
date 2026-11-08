import {lockWorkspace} from '../workspace-lock.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Webhook } from 'standardwebhooks';
import type { Database, Sql } from '../db.js';
import type { Actor } from '../service.js';
import { AppError, requireCondition } from '../errors.js';
import { supportDraft, type LocalWriter } from '../support-draft.js';
import { supportAnswer, type SupportTopic } from '../../shared/support.js';
import {
  customerSupportCommands, supportOperatorCommands,
  type SupportAutomationStatus, type SupportPolicyReview,
  type SupportDirectory,
  type SupportTicket,
  type SupportMessage,
  type SupportState,
} from '../../shared/customer-support.js';
import type { SupportProvider, SupportSubmission } from './provider.js';
import { ResendSupportInbox, supportDigest, type NativeSupportOptions, type NativeMessage } from './inbound.js';
export type { NativeSupportOptions, UnassignedSupportEmail } from './inbound.js';

type Mode = 'off' | 'capture' | 'live';
export type SupportOperatorGrant = { workspaceId: string; userId: string; actorId: string; reason: string; reference: string; check: () => Promise<boolean> };
export type SupportOptions = {
  mode: Mode;
  isOwner?: (user: string, workspace: string) => Promise<boolean>;
  isOperator?: (user: string, workspace: string) => Promise<boolean>;
  operatorAuthorized?: (user: string, workspace: string, reference: string) => Promise<boolean>;
  automationLiveApproved?: boolean;
  nativeInbound?: NativeSupportOptions;
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
  body_digest: string;
  state: string;
  mode: 'capture' | 'live';
  attempts: number;
  provider_id: string | null;
  reason: string | null;
  created_by: string;
  authority_kind: 'owner'|'operator'|'automation';
  authority_ref: string | null;
  policy_version: number | null;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sensitive =
  /\b(refund|dispute|chargeback|password|credential|secret|hacked|security|privacy|delete|erasure|export|recover|lost access|unauthori[sz]ed|card number)\b/i;
const clean = (value: string) => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\r\t]/g, ''));
const reviewCode = (row: TicketRow) =>
  row.draft ? hash(JSON.stringify([row.id, row.version, row.draft, row.draft_provenance])) : null;

type PolicyRow = { version: number; enabled: boolean; mode: 'capture'|'live'; responses: Record<string,string>; guidance_digest: string; valid_until: Date };
const safeTopics = ['plans','trial','audience','campaigns'] as const;
const publicGuidanceDigest = () => hash(JSON.stringify(safeTopics.map((topic) => supportAnswer(topic))));

export class CustomerSupport {
  private readonly grants = new WeakMap<Actor, SupportOperatorGrant>();
  constructor(
    readonly db: Database,
    readonly options: SupportOptions = { mode: 'off' },
  ) {}
  private async owner(actor: Actor) {
    const grant = this.grants.get(actor);
    if (grant) {
      requireCondition(await grant.check(), 403, 'support_operator_required', 'The independently verified support authority expired.');
      await this.db.tenant(actor.workspaceId, (sql) => this.retained(sql));
      requireCondition(this.options.mode !== 'off',503,'support_unavailable','Support is not configured.');
      return;
    }
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
    const grant = this.grants.get(actor);
    if (grant) { requireCondition(await grant.check(),403,'support_operator_required','Verify current support authority.'); return; }
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
      await lockWorkspace(sql,workspace);
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
      await this.retained(sql);
      const grant = this.grants.get(actor);
      if (grant) requireCondition(await grant.check(),403,'support_operator_required','The support authority expired before this change.');
      else requireCondition(await this.options.isOwner?.(actor.userId,actor.workspaceId),403,'owner_required','Verify current workspace ownership.');
      const result = await run(sql);
      if (grant) await sql.query('INSERT INTO customer_support_operator_audit(workspace_id,id,authority_ref,user_id,action,ticket_id,reason,operation_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [actor.workspaceId,randomUUID(),grant.reference,grant.userId,name,'id' in input ? input.id : null,grant.reason,input.operationKey]);
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
      const result = this.view(
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
      result.replyAddress = await this.replyAddress(sql,workspace,id);
      return result;
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
    if (this.grants.has(actor) || this.options.mode === 'capture' || (await this.options.isOperator?.(actor.userId, actor.workspaceId)))
      return ticket;
    return {
      ...ticket,
      draft: null,
      draftProvenance: null,
      reviewCode: null,
      messages: ticket.messages.filter((message) => message.kind !== 'draft'),
    };
  }
  /** Server-only port. HTTP/MCP bodies must never supply this grant; platform authentication mints it. */
  async executeForOperator(name: string, raw: unknown, grant: SupportOperatorGrant): Promise<unknown> {
    requireCondition(grant.workspaceId.length > 0 && grant.workspaceId.length <= 200 && grant.userId.length > 0 && grant.actorId.length > 0 && grant.reference.length > 0 && grant.reference.length <= 200 && grant.reason.trim().length > 0 && grant.reason.length <= 500 && typeof grant.check === 'function' && await grant.check(),403,'support_operator_required','Verify an exact support review case.');
    requireCondition(['support.get','support.draft','support.editDraft','support.approve','support.process','support.escalate','support.close',...Object.keys(supportOperatorCommands)].includes(name),403,'support_operator_scope','The operator case does not allow this action.');
    const actor: Actor = { workspaceId:grant.workspaceId,userId:grant.userId,actorId:grant.actorId,kind:'session',owner:false,scopes:['read'],brandIds:null };
    this.grants.set(actor,grant);
    try { return await this.execute(name,raw,actor); } finally { this.grants.delete(actor); }
  }
  async execute(name: string, raw: unknown, actor: Actor): Promise<unknown> {
    await this.owner(actor);
    if (name in supportOperatorCommands && name !== 'support.reauthorize') return this.policyCommand(name,raw,actor);
    requireCondition(name in customerSupportCommands || name === 'support.reauthorize', 404, 'unknown_command', 'Unknown support action.');
    switch (name) {
      case 'support.reauthorize': {
        const grant=this.grants.get(actor);
        requireCondition(grant,403,'support_operator_required','Only a freshly verified support operator can renew reply authority.');
        const input=supportOperatorCommands[name].schema.parse(raw);
        await this.mutate(actor,name,input,async(sql) => {
          const row=await this.ticket(sql,input.id,input.expectedVersion);
          requireCondition(row.state === 'queued' && row.draft && reviewCode(row) === input.reviewCode,409,'support_review_changed','Read and approve the exact current queued reply.');
          const jobs=(await sql.query<Dispatch>("SELECT * FROM customer_support_dispatches WHERE ticket_id=$1 AND state IN ('queued','submitting','uncertain') ORDER BY created_at FOR UPDATE",[row.id])).rows;
          const job=jobs[0];
          requireCondition(jobs.length === 1 && job && job.state === 'queued' && job.attempts === 0,409,'support_already_attempted','Only an unattempted queued reply can receive fresh authority. Reconcile uncertain attempts without resending.');
          requireCondition(job.body === row.draft && job.body_digest === hash(row.draft) && job.mode === row.mode && job.mode === this.options.mode,409,'support_review_changed','The frozen reply or transport changed after review.');
          await sql.query("UPDATE customer_support_dispatches SET created_by=$2,authority_kind='operator',authority_ref=$3,policy_version=NULL,reason=NULL,updated_at=now() WHERE id=$1",[job.id,grant.userId,grant.reference]);
          return {id:row.id};
        });
        return this.get(actor.workspaceId,input.id);
      }
      case 'support.automationStatus':
        customerSupportCommands[name].schema.parse(raw);
        return this.automationStatus(actor.workspaceId);
      case 'support.exerciseAutomation': {
        const input = customerSupportCommands[name].schema.parse(raw);
        requireCondition(this.options.mode === 'capture',409,'capture_only','This exercise is available only with captured transport.');
        await this.mutate(actor,name,input,async (sql) => {
          await this.queueAutomation(sql,actor.workspaceId,input.id,input.expectedVersion,actor.userId,true);
          return {id:input.id};
        });
        return this.processAuthorized(actor.workspaceId,input.id);
      }
      case 'support.prepareReplyAddress': {
        const input = customerSupportCommands[name].schema.parse(raw);
        await this.mutate(actor,name,input,async (sql) => {
          const row = await this.ticket(sql,input.id,input.expectedVersion);
          await this.prepareThread(sql,actor.workspaceId,row); return {id:row.id};
        });
        return this.get(actor.workspaceId,input.id);
      }
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
            replyRoutingConfigured:!!this.options.nativeInbound?.replyDomain,
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
          !/[\p{Cc}\p{Cf}]/u.test(input.subject) && clean(input.text),
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
            'INSERT INTO customer_support_dispatches(workspace_id,id,ticket_id,ticket_version,operation_key,body,body_digest,state,mode,created_by,authority_kind,authority_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
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
              this.grants.has(actor) ? 'operator' : 'owner',
              this.grants.get(actor)?.reference ?? null,
            ],
          );
          await this.prepareThread(sql,actor.workspaceId,row);
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
      if (job.authority_kind === 'owner' || job.state === 'queued') {
        requireCondition(await this.dispatchAuthorized(sql,workspace,job),403,'support_authority_expired','The original support approval is no longer valid for a new submission.');
      }
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
    const thread = await this.db.tenant(workspace, async (sql) => ({replyTo:await this.replyAddress(sql,workspace,id), messageId:(await sql.query<{last_message_id:string|null}>('SELECT last_message_id FROM customer_support_threads WHERE ticket_id=$1',[id])).rows[0]?.last_message_id}));
    let outcome: SupportSubmission = { state: 'unknown' };
    const provider = this.options.provider;
    if (submit) {
      const allowed=await this.locked(workspace,async(sql) => {
        const erased=(await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount;
        const current=(await sql.query<Dispatch>('SELECT * FROM customer_support_dispatches WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
        const currentTicket=await this.ticket(sql,id);
        if (erased || !current || current.state !== 'submitting' || currentTicket.state !== 'queued' || this.options.mode !== job.mode || !(await this.dispatchAuthorized(sql,workspace,job))) {
          if (current?.state === 'submitting') await sql.query("UPDATE customer_support_dispatches SET state='cancelled',reason='authority_changed_before_handoff',updated_at=now() WHERE id=$1",[job.id]);
          return false;
        }
        return true;
      });
      if (!allowed) return this.get(workspace,id);
    }
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
              ...(thread.replyTo ? {replyTo:thread.replyTo} : {}),
              ...(thread.messageId ? {inReplyTo:thread.messageId} : {}),
              automatic:job.authority_kind === 'automation',
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
      await sql.query('UPDATE customer_support_automation_runs SET state=$2,reason=$3 WHERE dispatch_id=$1',[job.id,next,next === 'uncertain' ? 'provider_unknown' : null]);
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
    await this.locked(workspace,async(sql) => {
      if ((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount) return;
      const policy=await this.currentPolicy(sql);
      if (!policy?.enabled || policy.valid_until <= new Date() || policy.mode !== this.options.mode) return;
      const candidates=(await sql.query<{id:string;version:number}>("SELECT id,version FROM customer_support_tickets WHERE state='open' ORDER BY created_at LIMIT 10")).rows;
      for (const ticket of candidates) await this.queueAutomation(sql,workspace,ticket.id,ticket.version,'system:support-policy',false);
    });
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
      try { await this.processAuthorized(workspace, job.ticket_id); processed++; } catch (error) {
        if (!(error instanceof AppError) || !['owner_required','support_operator_required','support_authority_expired','workspace_erased'].includes(error.code)) throw error;
      }
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
  private async currentPolicy(sql: Sql): Promise<PolicyRow | undefined> {
    return (await sql.query<PolicyRow>('SELECT * FROM customer_support_policies ORDER BY version DESC LIMIT 1')).rows[0];
  }
  private async dispatchAuthorized(sql: Sql, workspace: string, job: Dispatch) {
    if (job.authority_kind === 'operator') return !!job.authority_ref && !!(await this.options.operatorAuthorized?.(job.created_by,workspace,job.authority_ref));
    if (job.authority_kind === 'automation') {
      if (job.mode === 'capture' && job.policy_version === 0) return !!(await this.options.isOwner?.(job.created_by,workspace));
      const policy = await this.currentPolicy(sql);
      return !!policy?.enabled && policy.version === job.policy_version && policy.mode === job.mode &&
        policy.valid_until > new Date() && policy.guidance_digest === publicGuidanceDigest() &&
        (job.mode === 'capture' || this.options.automationLiveApproved === true);
    }
    return !!(await this.options.isOwner?.(job.created_by,workspace)) &&
      (job.mode === 'capture' || !!(await this.options.isOperator?.(job.created_by,workspace)));
  }
  private async automationStatus(workspace: string): Promise<SupportAutomationStatus> {
    return this.db.tenant(workspace,async (sql) => {
      const policy = await this.currentPolicy(sql);
      const counts = (await sql.query("SELECT count(*) FILTER(WHERE state='queued') pending,count(*) FILTER(WHERE state='accepted' AND mode='capture') captured,count(*) FILTER(WHERE state='uncertain') uncertain FROM customer_support_automation_runs")).rows[0];
      const last = (await sql.query<{reason:string|null}>('SELECT reason FROM customer_support_automation_runs ORDER BY created_at DESC,id DESC LIMIT 1')).rows[0];
      return {mode:this.options.mode,policyVersion:policy?.version ?? null,
        enabledTopics:policy?.enabled && policy.valid_until > new Date() ? Object.keys(policy.responses) : [],
        pending:Number(counts.pending),captured:Number(counts.captured),uncertain:Number(counts.uncertain),lastReason:last?.reason ?? null,writerConfigured:!!this.options.writer};
    });
  }
  private async policyCommand(name: string, raw: unknown, actor: Actor) {
    const grant = this.grants.get(actor);
    requireCondition(grant,403,'support_operator_required','Only independently verified support operators may approve automation policies.');
    if (name === 'support.policyHistory') {
      supportOperatorCommands[name].schema.parse(raw);
      return this.db.tenant(actor.workspaceId,async (sql) => ({policies:(await sql.query('SELECT version,enabled,mode,responses,guidance_digest,review_code,approved_by,authority_ref,valid_until,created_at FROM customer_support_policies ORDER BY version DESC LIMIT 30')).rows}));
    }
    if (name === 'support.policyPreview') {
      const input = supportOperatorCommands[name].schema.parse(raw);
      requireCondition(input.mode === this.options.mode && (input.mode !== 'live' || this.options.automationLiveApproved === true),409,'support_automation_disabled','Live automatic support requires separate explicit activation.');
      requireCondition(!input.useWriter || this.options.writer,503,'support_writer_unavailable','The public-guidance writer is not configured.');
      const replay=await this.db.tenant(actor.workspaceId,async(sql) => {
        const prior=(await sql.query<{request_hash:string;result:SupportPolicyReview}>('SELECT request_hash,result FROM operations WHERE actor_id=$1 AND operation_key=$2',['customer-support:'+actor.actorId,input.operationKey])).rows[0];
        if (prior) requireCondition(prior.request_hash === hash(JSON.stringify([name,input])),409,'operation_conflict','Retry the original policy preview request.');
        return prior?.result;
      });
      if (replay) return replay;
      const responses:Record<string,string> = {};
      for (const topic of input.topics) {
        if (input.useWriter) {
          const drafted = await supportDraft(topic,this.options.writer!);
          requireCondition(drafted.kind === 'draft' && drafted.draft,409,'human_handoff','Review the public guidance manually.');
          responses[topic] = drafted.draft;
        } else responses[topic] = supportAnswer(topic)!.text;
      }
      return this.mutate(actor,name,input,async (sql) => {
        const policy = await this.currentPolicy(sql);
        requireCondition((policy?.version ?? 0) === input.expectedVersion,409,'version_conflict','Reload the current automation policy.');
        const id=randomUUID(),validUntil=new Date(Date.now()+input.validForDays*86400000),expiresAt=new Date(Date.now()+3600000),guidanceDigest=publicGuidanceDigest();
        const code=hash(JSON.stringify([id,input.expectedVersion,input.enabled,input.mode,responses,guidanceDigest,validUntil.toISOString(),expiresAt.toISOString()]));
        await sql.query('INSERT INTO customer_support_policy_previews(workspace_id,id,parent_version,enabled,mode,responses,guidance_digest,review_code,valid_until,expires_at,created_by,authority_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[actor.workspaceId,id,input.expectedVersion,input.enabled,input.mode,JSON.stringify(responses),guidanceDigest,code,validUntil,expiresAt,actor.userId,grant.reference]);
        return {id,parentVersion:input.expectedVersion,enabled:input.enabled,mode:input.mode,responses,reviewCode:code,validUntil:validUntil.toISOString(),expiresAt:expiresAt.toISOString()} satisfies SupportPolicyReview;
      });
    }
    requireCondition(name === 'support.publishPolicy',404,'unknown_command','Unknown support policy action.');
    const input=supportOperatorCommands['support.publishPolicy'].schema.parse(raw);
    return this.mutate(actor,name,input,async (sql) => {
      const preview=(await sql.query<PolicyRow & {parent_version:number;review_code:string;expires_at:Date}>('SELECT * FROM customer_support_policy_previews WHERE id=$1',[input.previewId])).rows[0];
      requireCondition(preview && preview.review_code === input.reviewCode && preview.expires_at > new Date() && preview.valid_until > new Date() && preview.guidance_digest === publicGuidanceDigest(),409,'support_policy_review_changed','Read and approve a fresh exact policy preview.');
      const current=await this.currentPolicy(sql);
      requireCondition((current?.version ?? 0) === preview.parent_version,409,'version_conflict','The automation policy changed after review.');
      requireCondition(preview.mode === this.options.mode && (preview.mode !== 'live' || this.options.automationLiveApproved === true),409,'support_automation_disabled','The reviewed automation transport is not enabled.');
      const version=preview.parent_version+1;
      await sql.query('INSERT INTO customer_support_policies(workspace_id,version,enabled,mode,responses,guidance_digest,review_code,approved_by,authority_ref,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[actor.workspaceId,version,preview.enabled,preview.mode,JSON.stringify(preview.responses),preview.guidance_digest,preview.review_code,actor.userId,grant.reference,preview.valid_until]);
      return {version,enabled:preview.enabled,mode:preview.mode,responses:preview.responses};
    });
  }
  private async queueAutomation(sql: Sql, workspace: string, id: string, version: number, user: string, exercise: boolean) {
    const row=await this.ticket(sql,id,version),policy=await this.currentPolicy(sql);
    const fallback=exercise && this.options.mode === 'capture' && (!policy || !policy.enabled);
    const policyVersion=fallback ? 0 : policy?.version ?? 0;
    const prior=(await sql.query('SELECT FROM customer_support_automation_runs WHERE ticket_id=$1 AND input_version=$2 AND policy_version=$3',[id,version,policyVersion])).rowCount;
    if (prior) return;
    let reason:string|null=null;
    const latest=(await sql.query<{text:string;provenance:string}>("SELECT text,provenance FROM customer_support_messages WHERE ticket_id=$1 AND kind='incoming' ORDER BY created_at DESC,id DESC LIMIT 1",[id])).rows[0];
    const guidance=supportAnswer(row.topic);
    const counts=(await sql.query("SELECT count(*) total,count(*) FILTER(WHERE authority_kind='automation') automatic FROM customer_support_dispatches WHERE ticket_id=$1",[id])).rows[0];
    if (!fallback && (!policy?.enabled || policy.valid_until <= new Date() || policy.guidance_digest !== publicGuidanceDigest() || policy.mode !== this.options.mode || (policy.mode === 'live' && this.options.automationLiveApproved !== true))) reason='policy_unavailable';
    else if (row.state !== 'open') reason='human_handoff';
    else if (!latest || !guidance || sensitive.test(row.subject+' '+latest.text)) reason='sensitive_or_unknown_question';
    else if (!['workspace-owner','verified-thread'].includes(latest.provenance)) reason='sender_unverified';
    else if (latest.text.trim().toLowerCase().replace(/[?!.]+$/,'') !== guidance.title.toLowerCase().replace(/[?!.]+$/,'')) reason='uncertain_question';
    else if (Number(counts.total) >= 5) reason='support_reply_limit';
    else if (Number(counts.automatic) >= 1) reason='automatic_reply_limit';
    const response=fallback ? guidance?.text : policy?.responses[row.topic];
    if (!reason && !response) reason='topic_not_approved';
    if (!reason && row.mode === 'live' && (!row.reply_to || !this.options.provider || !this.options.sender)) reason='provider_unavailable';
    const runId=randomUUID(),dispatchId=reason ? null : randomUUID();
    await sql.query('INSERT INTO customer_support_automation_runs(workspace_id,id,ticket_id,input_version,policy_version,state,reason,dispatch_id,mode,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[workspace,runId,id,version,policyVersion,reason ? 'held' : 'queued',reason,dispatchId,this.options.mode,user]);
    if (reason) {
      if (row.state === 'open') await sql.query("UPDATE customer_support_tickets SET state='escalated',escalation_reason=$2,version=version+1,updated_at=now() WHERE id=$1",[id,reason]);
      return;
    }
    const body=response+'\n\nAutomated reply using approved public guidance. Reply to request a human.';
    await this.prepareThread(sql,workspace,row);
    await sql.query("INSERT INTO customer_support_dispatches(workspace_id,id,ticket_id,ticket_version,operation_key,body,body_digest,state,mode,created_by,authority_kind,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,'automation',$10)",[workspace,dispatchId,id,row.version,runId,body,hash(body),row.mode,user,policyVersion]);
    await sql.query("UPDATE customer_support_tickets SET state='queued',version=version+1,updated_at=now() WHERE id=$1",[id]);
  }
  private inbox() {
    const options=this.options.nativeInbound;
    requireCondition(options,503,'support_inbound_unavailable','Native support intake is not configured.');
    return new ResendSupportInbox(options,{
      resolve:async (tokenHash) => {
        const route=(await this.db.pool.query<{workspace_id:string;ticket_id:string;participant_digest:string}>('SELECT * FROM flockletter_customer_jobs.resolve_support_reply_route($1)',[tokenHash])).rows[0];
        return route ? {workspaceId:route.workspace_id,ticketId:route.ticket_id,participantDigest:route.participant_digest} : null;
      },
      reserve:async (route,providerId,eventId,digest) => this.locked(route.workspaceId,async(sql) => {
        await this.retained(sql);
        requireCondition((await sql.query('SELECT FROM workspaces LIMIT 1')).rowCount,422,'support_destination_unbound','The support workspace is not initialized.');
        const prior=(await sql.query<{digest:string;state:string;ticket_id:string|null;attempts:number}>('SELECT digest,state,ticket_id,attempts FROM customer_support_native_receipts WHERE provider_email_id=$1 FOR UPDATE',[providerId])).rows[0];
        if (prior) {
          requireCondition(prior.digest === digest,409,'support_event_conflict','The email identifier was reused with different metadata.');
          if (prior.state !== 'pending') return {id:prior.ticket_id};
          requireCondition(prior.attempts<5,503,'support_inbound_review_required','Provider retrieval needs operator review.');
          await sql.query('UPDATE customer_support_native_receipts SET attempts=attempts+1,updated_at=now() WHERE provider_email_id=$1',[providerId]);
        } else {
          const total=Number((await sql.query('SELECT count(*) FROM customer_support_native_receipts')).rows[0].count);
          requireCondition(total<5000,429,'support_limit','The support inbox needs operator review.');
          await sql.query("INSERT INTO customer_support_native_receipts(workspace_id,provider_email_id,event_id,digest,state,attempts) VALUES($1,$2,$3,$4,'pending',1)",[route.workspaceId,providerId,eventId,digest]);
        }
        return null;
      }),
      quarantine:async (route,providerId) => this.locked(route.workspaceId,async(sql) => { await this.retained(sql); await sql.query("UPDATE customer_support_native_receipts SET state='blocked',reason='unverified_thread_sender',updated_at=now() WHERE provider_email_id=$1 AND state='pending'",[providerId]); }),
      ingest:(message) => this.ingestNative(message),
    });
  }
  async receiveResend(body: Buffer, headers: Record<string,string>) {
    requireCondition(this.options.mode === 'live',503,'support_inbound_unavailable','Native support intake is not enabled.');
    return this.inbox().receive(body,headers);
  }
  private async prepareThread(sql: Sql, workspace: string, row: TicketRow) {
    if (!this.options.nativeInbound?.replyDomain || !row.reply_to) return;
    const inbox=this.inbox(),old=(await sql.query<{expires_at:Date}>('SELECT expires_at FROM customer_support_threads WHERE ticket_id=$1',[row.id])).rows[0];
    if (old && old.expires_at > new Date()) return;
    const nonce=randomUUID(),participant=inbox.participant(row.reply_to),token=inbox.token(workspace,row.id,participant,nonce),expires=new Date(Date.now()+29*86400000);
    await sql.query('INSERT INTO customer_support_threads(workspace_id,ticket_id,nonce,participant_digest,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,ticket_id) DO UPDATE SET nonce=EXCLUDED.nonce,participant_digest=EXCLUDED.participant_digest,token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at',[workspace,row.id,nonce,participant,supportDigest(token),expires]);
    await sql.query('SELECT flockletter_customer_jobs.register_support_reply_route($1,$2,$3,$4,$5)',[workspace,row.id,supportDigest(token),participant,expires]);
  }
  private async replyAddress(sql: Sql, workspace: string, id: string) {
    if (!this.options.nativeInbound?.replyDomain) return null;
    const thread=(await sql.query<{nonce:string;participant_digest:string;token_hash:string;expires_at:Date}>('SELECT nonce,participant_digest,token_hash,expires_at FROM customer_support_threads WHERE ticket_id=$1',[id])).rows[0];
    if (!thread || thread.expires_at <= new Date()) return null;
    const token=this.inbox().token(workspace,id,thread.participant_digest,thread.nonce);
    if (supportDigest(token) !== thread.token_hash) return null;
    return 'r+'+token+'@'+this.options.nativeInbound.replyDomain;
  }
  private async ingestNative(message: NativeMessage) {
    const workspace=message.route.workspaceId;
    return this.locked(workspace,async (sql) => {
      await this.retained(sql);
      requireCondition((await sql.query('SELECT FROM workspaces LIMIT 1')).rowCount,422,'support_destination_unbound','The support workspace is not initialized.');
      const old=(await sql.query<{digest:string;ticket_id:string|null;state:string}>('SELECT digest,ticket_id,state FROM customer_support_native_receipts WHERE provider_email_id=$1',[message.providerEmailId])).rows[0];
      if (old) {
        requireCondition(old.digest === message.receiptDigest,409,'support_event_conflict','The provider email identifier was reused.');
        if (old.state !== 'pending') return {id:old.ticket_id};
      }
      const totals=(await sql.query('SELECT (SELECT count(*) FROM customer_support_native_receipts) receipts,(SELECT count(*) FROM customer_support_tickets) tickets')).rows[0];
      requireCondition(Number(totals.receipts)<=5000 && (message.autoSubmitted || message.route.ticketId || Number(totals.tickets)<500),429,'support_limit','The support inbox needs operator review.');
      let id:string|null=null;
      if (!message.autoSubmitted) {
        if (message.route.ticketId) {
          const ticket=await this.ticket(sql,message.route.ticketId);
          // Recheck participant and retained route inside the workspace transaction.
          const thread=(await sql.query<{participant_digest:string;expires_at:Date}>('SELECT participant_digest,expires_at FROM customer_support_threads WHERE ticket_id=$1',[ticket.id])).rows[0];
          requireCondition(thread && thread.expires_at > new Date() && thread.participant_digest === this.inbox().participant(message.from) && message.authentication === 'pass',422,'support_thread_mismatch','The support reply route is no longer valid.');
          id=ticket.id;
          await sql.query("UPDATE customer_support_dispatches SET state='cancelled',reason='new_customer_message',updated_at=now() WHERE ticket_id=$1 AND state='queued' AND attempts=0",[id]);
          const safe=message.attachmentCount === 0 && !sensitive.test(message.subject+' '+message.text) && supportAnswer(ticket.topic);
          await sql.query("UPDATE customer_support_tickets SET state=$2,draft=NULL,draft_provenance=NULL,version=version+1,updated_at=now() WHERE id=$1",[id,safe ? 'open' : 'escalated']);
          await sql.query('UPDATE customer_support_threads SET last_message_id=$2 WHERE ticket_id=$1',[id,message.messageId]);
        } else {
          id=randomUUID();
          await sql.query("INSERT INTO customer_support_tickets(workspace_id,id,subject,topic,state,reply_to,requester_id,mode) VALUES($1,$2,$3,'other','escalated',$4,'native-unverified','live')",[workspace,id,message.subject,message.from]);
        }
        await this.message(sql,workspace,id,'incoming',message.text,message.route.ticketId && message.authentication === 'pass' && message.attachmentCount === 0 ? 'verified-thread' : 'untrusted-native-email');
      }
      await sql.query('UPDATE customer_support_native_receipts SET state=$2,ticket_id=$3,updated_at=now() WHERE provider_email_id=$1',[message.providerEmailId,id ? 'accepted' : 'ignored',id]);
      return {id};
    });
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
      envelope.to[0] === binding.address && !/[\p{Cc}\p{Cf}]/u.test(envelope.subject) && clean(envelope.text),
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
