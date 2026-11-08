import {lockWorkspace} from '../workspace-lock.js';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import type { Actor } from '../service.js';
import { AppError, requireCondition } from '../errors.js';
import { customerAudienceCommands, type AudienceSettingsView } from '../../shared/customer-audience.js';
import { normalizedEmail } from '../../shared/subscriber.js';
import { importRows } from '../subscribers/import-preview.js';
import { plans } from '../../shared/contracts.js';
import { workspaceAccess } from '../campaign/access.js';

type Mode = 'exercise' | 'live' | 'off';
type Policy = { purpose: string; policyVersion: string; consentText: string; sourceDomain: string };
type Settings = {
  enabled: boolean;
  purpose: string;
  policy_version: string;
  consent_text: string;
  source_domain: string;
  form_token: string;
  exercise_key: Buffer;
};
type Confirmation = {
  id: string;
  subscriber_id: string;
  token_hash: string;
  mode: 'exercise' | 'live';
  state: string;
  policy_snapshot: Policy;
  expires_at: Date;
  email_normalized: string;
  attempts: number;
  provider_id: string | null;
};
export type ConfirmationEnvelope = {
  operationKey: string;
  to: string;
  brandName: string;
  confirmUrl: string;
  unsubscribeUrl: string;
  mode: 'live';
};
export interface CustomerConfirmationPort {
  submit(
    message: ConfirmationEnvelope,
  ): Promise<{ state: 'accepted' | 'rejected' | 'unknown'; providerId?: string }>;
  lookup(operationKey: string): Promise<{ state: 'accepted' | 'rejected' | 'unknown'; providerId?: string }>;
}
export type CustomerAudienceOptions = {
  mode: Mode;
  origin: string;
  checkOwner: (user: string, workspace: string) => Promise<boolean>;
  contactLimit?: (sql: Sql, workspace: string) => Promise<number>;
  confirmationKey?: Buffer;
  provider?: CustomerConfirmationPort;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const genericReceipt = {
  status: 'pending_confirmation',
  message: 'Check your email for a confirmation if this address is eligible.',
};
const invalidLink = () =>
  new AppError(410, 'link_unavailable', 'This link is invalid, expired or already used.');
const scopePattern = /^org_[A-Za-z0-9_-]{1,120}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function parseForm(value: string) {
  if (value.length > 900 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidLink();
  let fields: unknown;
  try {
    fields = JSON.parse(Buffer.from(value, 'base64url').toString());
  } catch {
    throw invalidLink();
  }
  if (
    !Array.isArray(fields) ||
    fields.length !== 3 ||
    !fields.every((v) => typeof v === 'string') ||
    !scopePattern.test(fields[0]!) ||
    !uuidPattern.test(fields[1]!) ||
    !/^[a-f0-9]{48}$/.test(fields[2]!)
  )
    throw invalidLink();
  return { workspace: fields[0] as string, brand: fields[1] as string };
}
function policy(row: Settings): Policy {
  return {
    purpose: row.purpose,
    policyVersion: row.policy_version,
    consentText: row.consent_text,
    sourceDomain: row.source_domain,
  };
}
async function settings(sql: Sql) {
  return (
    await sql.query<Settings>(
      'SELECT enabled,purpose,policy_version,consent_text,source_domain,form_token,exercise_key FROM customer_audience_settings',
    )
  ).rows[0];
}
async function assertBrand(sql: Sql, actor: Actor, brand: string) {
  requireCondition(
    actor.brandIds === null || actor.brandIds.includes(brand),
    404,
    'brand_unavailable',
    'This brand is unavailable.',
  );
  const row = (await sql.query<{ name: string }>('SELECT name FROM brands WHERE id=$1', [brand])).rows[0];
  requireCondition(row, 404, 'brand_unavailable', 'This brand is unavailable.');
  return row.name;
}
export async function workspaceContactEmails(sql: Sql, selectedBrand: string) {
  const emails = new Set<string>();
  const brands = (await sql.query<{ id: string }>('SELECT id FROM brands ORDER BY id')).rows;
  for (const brand of brands) {
    await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand.id]);
    for (const row of (
      await sql.query<{ email_normalized: string }>(
        "SELECT email_normalized FROM subscribers WHERE state IN ('pending','confirmed')",
      )
    ).rows)
      emails.add(row.email_normalized);
  }
  await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [selectedBrand]);
  return emails;
}
export async function workspaceContactCount(sql: Sql, selectedBrand: string) {
  return (await workspaceContactEmails(sql, selectedBrand)).size;
}
export async function productionConsentEligible(sql: Sql, subscriberId: string) {
  const row = (
    await sql.query<{ exercise: boolean; live: boolean }>(
      `
    SELECT EXISTS(SELECT FROM subscriber_consent_events WHERE subscriber_id=$1 AND event='confirmed'
      AND source='customer-exercise-confirmation') AS exercise,
    EXISTS(SELECT FROM subscriber_consent_events WHERE subscriber_id=$1 AND event='confirmed'
      AND source='customer-live-confirmation') AS live`,
      [subscriberId],
    )
  ).rows[0]!;
  return !row.exercise || row.live;
}
async function factualEvent(
  sql: Sql,
  workspace: string,
  brand: string,
  subscriber: string,
  event: string,
  p: Policy,
  source: string,
) {
  await sql.query(
    `INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      workspace,
      brand,
      randomUUID(),
      subscriber,
      event,
      p.purpose,
      p.policyVersion,
      hash(p.consentText),
      source,
      p.sourceDomain,
    ],
  );
}

export class CustomerAudience {
  constructor(
    readonly db: Database,
    readonly options: CustomerAudienceOptions,
  ) {}
  private async owner(actor: Actor) {
    requireCondition(
      actor.kind === 'session' &&
        actor.owner &&
        (await this.options.checkOwner(actor.userId, actor.workspaceId)),
      403,
      'owner_required',
      'Use a current workspace owner session.',
    );
  }
  private async authority(sql: Sql, actor: Actor, brand: string, delegable: boolean) {
    if (actor.kind === 'session') return this.owner(actor);
    requireCondition(delegable, 403, 'owner_required', 'Use a current workspace owner session.');
    requireCondition(
      actor.owner &&
        actor.actorId.startsWith('connection:') &&
        actor.scopes.includes('audience:write') &&
        actor.brandIds !== null &&
        actor.brandIds.includes(brand) &&
        (await this.options.checkOwner(actor.userId, actor.workspaceId)),
      403,
      'scope_required',
      'This action requires a current owner-issued audience write grant for this brand.',
    );
    const grant = await sql.query(
      `SELECT id FROM connections WHERE id::text=$1 AND issuer_id=$2
      AND revoked_at IS NULL AND expires_at>clock_timestamp() AND 'audience:write'=ANY(scopes)
      AND $3::uuid=ANY(brand_ids) FOR SHARE`,
      [actor.actorId.slice('connection:'.length), actor.userId, brand],
    );
    requireCondition(
      grant.rowCount,
      403,
      'scope_required',
      'This audience write grant has expired, changed or been revoked.',
    );
  }
  private key(row: Settings, mode: 'exercise' | 'live') {
    const key = mode === 'exercise' ? row.exercise_key : this.options.confirmationKey;
    requireCondition(
      key?.length === 32,
      503,
      'confirmation_setup_required',
      'Configure the confirmation sender before enabling signup.',
    );
    return key;
  }
  private token(row: Settings, mode: 'exercise' | 'live', id: string, action = 'confirm') {
    return (
      id +
      '.' +
      createHmac('sha256', this.key(row, mode))
        .update('customer-confirmation-v1/' + action + '/' + row.form_token + '/' + id)
        .digest('base64url')
    );
  }
  private async maximum(sql: Sql, workspace: string) {
    if (this.options.contactLimit) return this.options.contactLimit(sql, workspace);
    const access = await workspaceAccess(sql);
    return plans.find((p) => p.id === access.plan)?.contacts ?? 250;
  }
  async execute(name: string, raw: unknown, actor: Actor): Promise<unknown> {
    if (!(name in customerAudienceCommands)) return undefined;
    const definition = customerAudienceCommands[name as keyof typeof customerAudienceCommands];
    const delegable = definition.scope === 'audience:write';
    if (!delegable)
      requireCondition(
        actor.kind === 'session' && actor.owner,
        403,
        'owner_required',
        'Use a current workspace owner session.',
      );
    const input = definition.schema.parse(raw) as { brandId: string; operationKey?: string } & Record<
      string,
      unknown
    >;
    return this.db.brand(actor.workspaceId, input.brandId, async (sql) => {
      if (definition.mutation || delegable)
        await lockWorkspace(sql,actor.workspaceId);
      await this.authority(sql, actor, input.brandId, delegable);
      const brandName = await assertBrand(sql, actor, input.brandId);
      if (!definition.mutation) {
        if (name === 'audienceOnboarding.status') return this.status(sql, input.brandId, brandName);
        if (name === 'audienceOnboarding.importResult') {
          const saved = (
            await sql.query<{ result: unknown }>(
              'SELECT result FROM customer_audience_imports WHERE id=$1 AND ($2::boolean OR actor_id=$3)',
              [input.id, actor.kind === 'session', actor.actorId],
            )
          ).rows[0];
          requireCondition(saved, 404, 'import_unavailable', 'This import is unavailable for this brand.');
          return saved.result;
        }
        return this.captured(sql, actor.workspaceId, input.brandId, String(input.id));
      }
      requireCondition(
        this.options.mode !== 'off',
        503,
        'audience_disabled',
        'Customer audience setup is disabled.',
      );
      const digest = hash(JSON.stringify([name, input]));
      const prior = (
        await sql.query<{ request_hash: string; result: unknown }>(
          'SELECT request_hash,result FROM operations WHERE actor_id=$1 AND operation_key=$2',
          [actor.actorId, input.operationKey],
        )
      ).rows[0];
      if (prior) {
        requireCondition(
          prior.request_hash === digest,
          409,
          'operation_conflict',
          'Use the original input for this request.',
        );
        return prior.result;
      }
      let result: unknown;
      if (name === 'audienceOnboarding.configure') result = await this.configure(sql, actor, input);
      else if (name === 'audienceOnboarding.import') result = await this.importContacts(sql, actor, raw);
      else if (name === 'audienceOnboarding.exerciseConfirm') {
        requireCondition(
          this.options.mode === 'exercise',
          403,
          'exercise_only',
          'Captured confirmation is available only in the exercise.',
        );
        result = await this.confirmInTransaction(
          sql,
          actor.workspaceId,
          input.brandId,
          String(input.id),
          undefined,
          true,
        );
      } else {
        const row = await settings(sql);
        requireCondition(
          row?.enabled,
          422,
          'signup_disabled',
          'Configure and enable this brand signup first.',
        );
        if (name === 'audienceOnboarding.signup') {
          requireCondition(
            this.options.mode === 'exercise',
            403,
            'exercise_only',
            'Use the public signup form for a live subscriber.',
          );
          const p = customerAudienceCommands['audienceOnboarding.signup'].schema.parse(raw);
          requireCondition(
            p.policyVersion === row.policy_version,
            409,
            'consent_changed',
            'Reload the current consent wording.',
          );
          result = await this.signupInTransaction(
            sql,
            actor.workspaceId,
            input.brandId,
            row,
            p.email,
            'owner-exercise',
          );
        } else {
          const id = String(input.subscriberId);
          const person = (
            await sql.query<{ email_normalized: string; state: string }>(
              'SELECT email_normalized,state FROM subscribers WHERE id=$1 FOR UPDATE',
              [id],
            )
          ).rows[0];
          requireCondition(
            person?.state === 'pending',
            422,
            'confirmation_ineligible',
            'Choose a pending contact.',
          );
          result = await this.queue(sql, actor.workspaceId, input.brandId, row, id);
        }
      }
      await sql.query(
        'INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',
        [actor.workspaceId, actor.actorId, input.operationKey, digest, JSON.stringify(result)],
      );
      await sql.query(
        'INSERT INTO audit(workspace_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
        [actor.workspaceId, randomUUID(), actor.actorId, name, input.brandId],
      );
      return result;
    });
  }
  private async status(sql: Sql, brandId: string, brandName: string): Promise<AudienceSettingsView> {
    const row = await settings(sql);
    const messages = (
      await sql.query<{ id: string; email: string; state: string; mode: string; created_at: Date }>(`
      SELECT c.id,s.email_normalized AS email,c.state,c.mode,c.created_at FROM customer_audience_confirmations c
      JOIN subscribers s USING(workspace_id,brand_id) WHERE s.id=c.subscriber_id ORDER BY c.created_at DESC LIMIT 50`)
    ).rows;
    const imports = (
      await sql.query<{ id: string; source: string; created_at: Date; rows: number }>(
        "SELECT id,source,created_at,jsonb_array_length(result->'rows') rows FROM customer_audience_imports ORDER BY created_at DESC LIMIT 20",
      )
    ).rows;
    return {
      brandId,
      brandName,
      mode: this.options.mode,
      enabled: row?.enabled ?? false,
      purpose: row?.purpose ?? 'brand_marketing',
      policyVersion: row?.policy_version ?? 'v1',
      consentText: row?.consent_text ?? '',
      sourceDomain: row?.source_domain ?? '',
      publicUrl: row ? this.options.origin + '/newsletter/' + row.form_token : null,
      trackingEnabled: false,
      imports: imports.map(({ created_at, ...item }) => ({ ...item, createdAt: created_at.toISOString() })),
      messages: messages.map(({ created_at, ...m }) => ({ ...m, createdAt: created_at.toISOString() })),
    };
  }
  private async configure(sql: Sql, actor: Actor, raw: unknown) {
    const input = customerAudienceCommands['audienceOnboarding.configure'].schema.parse(raw),
      old = await settings(sql);
    if (old && old.policy_version === input.policyVersion)
      requireCondition(
        old.consent_text === input.consentText && old.purpose === input.purpose,
        409,
        'policy_version_required',
        'Use a new policy version when consent wording changes.',
      );
    const form =
      old?.form_token ??
      Buffer.from(
        JSON.stringify([actor.workspaceId, input.brandId, randomBytes(24).toString('hex')]),
      ).toString('base64url');
    await sql.query(
      `INSERT INTO customer_audience_settings(workspace_id,brand_id,enabled,purpose,policy_version,consent_text,source_domain,form_token,exercise_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,brand_id) DO UPDATE SET
      enabled=excluded.enabled,purpose=excluded.purpose,policy_version=excluded.policy_version,consent_text=excluded.consent_text,
      source_domain=excluded.source_domain,updated_at=now()`,
      [
        actor.workspaceId,
        input.brandId,
        input.enabled,
        input.purpose,
        input.policyVersion,
        input.consentText,
        input.sourceDomain,
        form,
        randomBytes(32),
      ],
    );
    return {
      configured: true,
      brandId: input.brandId,
      publicUrl: this.options.origin + '/newsletter/' + form,
      mode: this.options.mode,
    };
  }
  private async importContacts(sql: Sql, actor: Actor, raw: unknown) {
    const input = customerAudienceCommands['audienceOnboarding.import'].schema.parse(raw);
    const rows = importRows(input),
      emails = await workspaceContactEmails(sql, input.brandId),
      maximum = await this.maximum(sql, actor.workspaceId);
    let remaining = Math.max(0, maximum - emails.size);
    const outcomes: { row: number; outcome: string; subscriberId?: string }[] = [];
    for (const row of rows) {
      if ('issue' in row) {
        outcomes.push({ row: row.row, outcome: row.issue });
        continue;
      }
      const prior = (
        await sql.query<{ id: string; state: string }>(
          'SELECT id,state FROM subscribers WHERE email_normalized=$1 FOR UPDATE',
          [row.address],
        )
      ).rows[0];
      if (prior) {
        outcomes.push({ row: row.row, outcome: 'kept_' + prior.state, subscriberId: prior.id });
        continue;
      }
      if (!remaining && !emails.has(row.address)) {
        outcomes.push({ row: row.row, outcome: 'contact_limit' });
        continue;
      }
      const id = randomUUID();
      await sql.query(
        "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,'pending')",
        [actor.workspaceId, input.brandId, id, row.address],
      );
      if (!emails.has(row.address)) {
        remaining--;
        emails.add(row.address);
      }
      outcomes.push({ row: row.row, outcome: 'pending_added', subscriberId: id });
    }
    const id = randomUUID(),
      result = {
        id,
        brandId: input.brandId,
        source: input.source,
        mode: this.options.mode,
        confirmationRequired: true,
        rows: outcomes,
      };
    await sql.query(
      'INSERT INTO customer_audience_imports(workspace_id,brand_id,id,operation_key,actor_id,source,file_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        actor.workspaceId,
        input.brandId,
        id,
        input.operationKey,
        actor.actorId,
        input.source,
        hash(input.csvBase64),
        JSON.stringify(result),
      ],
    );
    return result;
  }
  private async signupInTransaction(
    sql: Sql,
    workspace: string,
    brand: string,
    row: Settings,
    email: string,
    source: string,
  ) {
    const prior = (
      await sql.query<{ id: string; state: string }>(
        'SELECT id,state FROM subscribers WHERE email_normalized=$1 FOR UPDATE',
        [email],
      )
    ).rows[0];
    if (prior && ['unsubscribed', 'hard_bounced', 'complained'].includes(prior.state)) return genericReceipt;
    let id = prior?.id;
    if (!id) {
      const emails = await workspaceContactEmails(sql, brand);
      requireCondition(
        emails.has(email) || emails.size < (await this.maximum(sql, workspace)),
        429,
        'contact_limit',
        'This brand cannot accept another subscription right now.',
      );
      id = randomUUID();
      await sql.query(
        "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,'pending')",
        [workspace, brand, id, email],
      );
    }
    if (prior?.state === 'confirmed' && (await productionConsentEligible(sql, id))) return genericReceipt;
    await factualEvent(sql, workspace, brand, id, 'signup_requested', policy(row), source);
    await this.queue(sql, workspace, brand, row, id);
    return genericReceipt;
  }
  private async queue(sql: Sql, workspace: string, brand: string, row: Settings, subscriber: string) {
    const existing = (
      await sql.query<{ id: string }>(
        `SELECT id FROM customer_audience_confirmations WHERE subscriber_id=$1 AND state IN
      ('queued','submitting','uncertain') OR subscriber_id=$1 AND state IN ('captured','accepted')
      AND created_at>now()-interval '10 minutes' ORDER BY created_at DESC LIMIT 1`,
        [subscriber],
      )
    ).rows[0];
    if (existing) return { id: existing.id, status: 'confirmation_exists' };
    const daily = (
      await sql.query<{ n: number }>(
        "SELECT count(*)::int n FROM customer_audience_confirmations WHERE subscriber_id=$1 AND created_at>now()-interval '24 hours'",
        [subscriber],
      )
    ).rows[0]!.n;
    requireCondition(daily < 5, 429, 'confirmation_limit', 'Wait before requesting another confirmation.');
    const mode = this.options.mode;
    requireCondition(
      mode === 'exercise' || (mode === 'live' && this.options.provider && this.options.confirmationKey),
      503,
      'confirmation_setup_required',
      'Configure the confirmation provider.',
    );
    const id = randomUUID(),
      token = this.token(row, mode, id);
    await sql.query(
      `INSERT INTO customer_audience_confirmations(workspace_id,brand_id,id,subscriber_id,token_hash,mode,state,policy_snapshot,unsubscribe_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '24 hours')`,
      [
        workspace,
        brand,
        id,
        subscriber,
        hash(token),
        mode,
        mode === 'exercise' ? 'captured' : 'queued',
        JSON.stringify(policy(row)),
        hash(this.token(row, mode, id, 'unsubscribe')),
      ],
    );
    return { id, status: mode === 'exercise' ? 'captured' : 'queued' };
  }
  private async captured(sql: Sql, workspace: string, brand: string, id: string) {
    const row = await settings(sql),
      message = (
        await sql.query<Confirmation>(
          'SELECT c.*,s.email_normalized FROM customer_audience_confirmations c JOIN subscribers s USING(workspace_id,brand_id) WHERE c.id=$1 AND s.id=c.subscriber_id',
          [id],
        )
      ).rows[0];
    requireCondition(
      row && message?.mode === 'exercise',
      404,
      'capture_unavailable',
      'This captured confirmation is unavailable.',
    );
    return {
      id,
      to: message.email_normalized,
      state: message.state,
      mode: 'exercise',
      confirmationUrl:
        this.options.origin +
        '/newsletter/' +
        row.form_token +
        '/confirm?t=' +
        this.token(row, 'exercise', id),
      unsubscribeUrl:
        this.options.origin +
        '/newsletter/' +
        row.form_token +
        '/unsubscribe?t=' +
        this.token(row, 'exercise', id, 'unsubscribe'),
      text:
        'Confirm your subscription to ' +
        message.policy_snapshot.purpose +
        '. This is a captured exercise message.',
    };
  }
  private async confirmInTransaction(
    sql: Sql,
    workspace: string,
    brand: string,
    id: string,
    token?: string,
    exercise = false,
  ) {
    const row = await settings(sql);
    requireCondition(row?.enabled, 410, 'link_unavailable', 'This signup is unavailable.');
    const message = (
      await sql.query<Confirmation>(
        `SELECT c.*,s.email_normalized FROM customer_audience_confirmations c JOIN subscribers s
      USING(workspace_id,brand_id) WHERE c.id=$1 AND s.id=c.subscriber_id FOR UPDATE OF c,s`,
        [id],
      )
    ).rows[0];
    if (!message) throw invalidLink();
    const candidate = exercise ? this.token(row, 'exercise', id) : (token ?? '');
    if (exercise && message.mode !== 'exercise') throw invalidLink();
    const digest = hash(candidate);
    if (
      !timingSafeEqual(Buffer.from(digest), Buffer.from(message.token_hash)) ||
      message.expires_at.getTime() < Date.now()
    )
      throw invalidLink();
    const person = (
      await sql.query<{ state: string }>('SELECT state FROM subscribers WHERE id=$1', [message.subscriber_id])
    ).rows[0];
    if (!person || !['pending', 'confirmed'].includes(person.state)) throw invalidLink();
    if (message.state === 'confirmed') return { confirmed: true, mode: message.mode };
    if (!['captured', 'accepted', 'submitting', 'uncertain'].includes(message.state)) throw invalidLink();
    const changed = await sql.query(
      "UPDATE subscribers SET state='confirmed',confirmed_at=now(),updated_at=now() WHERE id=$1 AND state IN ('pending','confirmed') RETURNING id",
      [message.subscriber_id],
    );
    if (!changed.rowCount) throw invalidLink();
    await factualEvent(
      sql,
      workspace,
      brand,
      message.subscriber_id,
      'confirmed',
      message.policy_snapshot,
      'customer-' + message.mode + '-confirmation',
    );
    await sql.query(
      "UPDATE customer_audience_confirmations SET state='confirmed',consumed_at=now() WHERE id=$1",
      [id],
    );
    return { confirmed: true, mode: message.mode };
  }
  async publicForm(form: string) {
    const { workspace, brand } = parseForm(form);
    return this.db.brand(workspace, brand, async (sql) => {
      const row = await settings(sql);
      if (!row?.enabled || row.form_token !== form || this.options.mode === 'off') throw invalidLink();
      const name = (await sql.query<{ name: string }>('SELECT name FROM brands WHERE id=$1', [brand])).rows[0]
        ?.name;
      return { brandName: name, ...policy(row), mode: this.options.mode };
    });
  }
  async publicSignup(form: string, raw: unknown) {
    const { workspace, brand } = parseForm(form),
      input = raw as Record<string, unknown>;
    const email = normalizedEmail.safeParse(input?.email);
    requireCondition(
      email.success && input?.consentAffirmed === true,
      422,
      'consent_required',
      'Enter your email and affirm the displayed consent.',
    );
    return this.db.brand(workspace, brand, async (sql) => {
      await lockWorkspace(sql,workspace);
      const row = await settings(sql);
      if (!row?.enabled || row.form_token !== form || this.options.mode === 'off') throw invalidLink();
      requireCondition(
        input.policyVersion === row.policy_version,
        409,
        'consent_changed',
        'Reload the current consent wording.',
      );
      const budget = (
        await sql.query<{ requests: number }>(
          `INSERT INTO subscriber_rate_buckets(workspace_id,brand_id,bucket,window_at,requests)
        VALUES($1,$2,$3,now(),1) ON CONFLICT(workspace_id,brand_id,bucket) DO UPDATE SET
        requests=CASE WHEN subscriber_rate_buckets.window_at<now()-interval '24 hours' THEN 1 ELSE least(subscriber_rate_buckets.requests+1,11) END,
        window_at=CASE WHEN subscriber_rate_buckets.window_at<now()-interval '24 hours' THEN now() ELSE subscriber_rate_buckets.window_at END RETURNING requests`,
          [workspace, brand, 'customer-signup/' + hash(email.data)],
        )
      ).rows[0]!;
      if (budget.requests > 10) return genericReceipt;
      return this.signupInTransaction(
        sql,
        workspace,
        brand,
        row,
        email.data,
        'customer-public-' + this.options.mode + '-signup',
      );
    });
  }
  async confirm(form: string, token: string) {
    const { workspace, brand } = parseForm(form),
      id = token.split('.')[0] ?? '';
    if (!uuidPattern.test(id) || token.length !== 80) throw invalidLink();
    return this.db.brand(workspace, brand, async (sql) => {
      await lockWorkspace(sql,workspace);
      const row = await settings(sql);
      if (!row || row.form_token !== form) throw invalidLink();
      return this.confirmInTransaction(sql, workspace, brand, id, token);
    });
  }
  async unsubscribeConfirmation(form: string, token: string) {
    const { workspace, brand } = parseForm(form),
      id = token.split('.')[0] ?? '';
    if (!uuidPattern.test(id) || token.length !== 80) return;
    await this.db.brand(workspace, brand, async (sql) => {
      await lockWorkspace(sql,workspace);
      const row = await settings(sql);
      if (!row || row.form_token !== form) return;
      const message = (
        await sql.query<{ subscriber_id: string; unsubscribe_hash: string; policy_snapshot: Policy }>(
          'SELECT subscriber_id,unsubscribe_hash,policy_snapshot FROM customer_audience_confirmations WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!message || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(message.unsubscribe_hash)))
        return;
      await applyCustomerUnsubscribe(sql, workspace, brand, message.subscriber_id, message.policy_snapshot);
    });
  }
  async tick(workspace: string, brand: string) {
    if (this.options.mode !== 'live' || !this.options.provider) return { processed: false };
    const claim = await this.db.brand(workspace, brand, async (sql) => {
      await lockWorkspace(sql,workspace);
      const row = await settings(sql);
      if (!row) return;
      const job = (
        await sql.query<Confirmation>(`SELECT c.*,s.email_normalized FROM customer_audience_confirmations c
        JOIN subscribers s USING(workspace_id,brand_id) WHERE s.id=c.subscriber_id AND c.mode='live'
        AND c.state IN ('queued','submitting','uncertain') AND (c.next_check_at IS NULL OR c.next_check_at<now())
        ORDER BY c.created_at,c.id LIMIT 1 FOR UPDATE OF c,s`)
      ).rows[0];
      if (!job) return;
      const person = (
        await sql.query<{ state: string }>('SELECT state FROM subscribers WHERE id=$1', [job.subscriber_id])
      ).rows[0];
      const submit = job.state === 'queued';
      const erased = Boolean((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount);
      const eligible =
        person?.state === 'pending' ||
        (person?.state === 'confirmed' && !(await productionConsentEligible(sql, job.subscriber_id)));
      if (submit && (erased || !row.enabled || !eligible || job.expires_at.getTime() < Date.now())) {
        await sql.query("UPDATE customer_audience_confirmations SET state='cancelled' WHERE id=$1", [job.id]);
        return { cancelled: true };
      }
      await sql.query(
        "UPDATE customer_audience_confirmations SET state=$2,attempts=attempts+$3,next_check_at=now()+interval '1 minute' WHERE id=$1",
        [job.id, submit ? 'submitting' : 'uncertain', Number(submit)],
      );
      const brandName =
        (await sql.query<{ name: string }>('SELECT name FROM brands WHERE id=$1', [brand])).rows[0]?.name ??
        'Newsletter';
      const token = this.token(row, 'live', job.id);
      requireCondition(
        hash(token) === job.token_hash,
        503,
        'confirmation_key_changed',
        'Restore the configured confirmation signer before processing.',
      );
      return {
        job,
        submit,
        message: {
          operationKey: job.id,
          to: job.email_normalized,
          brandName,
          confirmUrl: this.options.origin + '/newsletter/' + row.form_token + '/confirm?t=' + token,
          unsubscribeUrl:
            this.options.origin +
            '/newsletter/' +
            row.form_token +
            '/unsubscribe?t=' +
            this.token(row, 'live', job.id, 'unsubscribe'),
          mode: 'live' as const,
        },
      };
    });
    if (!claim) return { processed: false };
    if ('cancelled' in claim) return { processed: true };
    let result: Awaited<ReturnType<CustomerConfirmationPort['submit']>> = { state: 'unknown' };
    try {
      result = claim.submit
        ? await this.db.brand(workspace, brand, async (sql) => {
            await lockWorkspace(sql,workspace);
            if ((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount) {
              await sql.query(
                "UPDATE customer_audience_confirmations SET state='cancelled',attempts=greatest(attempts-1,0) WHERE id=$1 AND state='submitting'",
                [claim.job.id],
              );
              return { state: 'rejected' as const };
            }
            return this.options.provider!.submit(claim.message);
          })
        : await this.options.provider.lookup(claim.job.id);
    } catch {
      /* Reconcile the committed attempt. */
    }
    await this.db.brand(workspace, brand, async (sql) => {
      await lockWorkspace(sql,workspace);
      await sql.query(
        `UPDATE customer_audience_confirmations SET state=$2,provider_id=coalesce($3,provider_id),
        next_check_at=now()+interval '1 minute' WHERE id=$1 AND state IN ('submitting','uncertain')`,
        [
          claim.job.id,
          result.state === 'accepted' ? 'accepted' : result.state === 'rejected' ? 'cancelled' : 'uncertain',
          result.providerId ?? null,
        ],
      );
    });
    return { processed: true };
  }
}

export const customerAudienceTables = [
  { name: 'customer_audience_settings', scope: 'brand', permissions: ['SELECT', 'INSERT', 'UPDATE'] },
  { name: 'customer_audience_imports', scope: 'brand', permissions: ['SELECT', 'INSERT'] },
  { name: 'customer_audience_confirmations', scope: 'brand', permissions: ['SELECT', 'INSERT', 'UPDATE'] },
  { name: 'customer_audience_optouts', scope: 'brand', permissions: ['SELECT', 'INSERT', 'UPDATE'] },
] as const;

export async function createCustomerOptOut(
  sql: Sql,
  workspace: string,
  brand: string,
  subscriberId: string,
  origin: string,
) {
  const person = (
    await sql.query("SELECT id FROM subscribers WHERE id=$1 AND state='confirmed' FOR UPDATE", [subscriberId])
  ).rowCount;
  requireCondition(person, 409, 'recipient_ineligible', 'The recipient is no longer confirmed.');
  const secret = randomBytes(32).toString('base64url'),
    id = randomUUID();
  const token = Buffer.from(JSON.stringify([workspace, brand, id, secret])).toString('base64url');
  await sql.query(
    'INSERT INTO customer_audience_optouts(workspace_id,brand_id,id,subscriber_id,token_hash) VALUES($1,$2,$3,$4,$5)',
    [workspace, brand, id, subscriberId, hash(token)],
  );
  return { url: origin + '/newsletter/opt-out?t=' + token };
}

export async function redeemCustomerOptOut(db: Database, token: string) {
  if (token.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(token)) return;
  let fields: unknown;
  try {
    fields = JSON.parse(Buffer.from(token, 'base64url').toString());
  } catch {
    return;
  }
  if (
    !Array.isArray(fields) ||
    fields.length !== 4 ||
    !fields.every((s) => typeof s === 'string') ||
    !scopePattern.test(fields[0]!) ||
    !uuidPattern.test(fields[1]!) ||
    !uuidPattern.test(fields[2]!)
  )
    return;
  const [workspace, brand, id] = fields as string[];
  await db.brand(workspace!, brand!, async (sql) => {
    await lockWorkspace(sql,workspace!);
    const row = (
      await sql.query<{ subscriber_id: string; token_hash: string }>(
        'SELECT subscriber_id,token_hash FROM customer_audience_optouts WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!row || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(row.token_hash))) return;
    await applyCustomerUnsubscribe(sql, workspace!, brand!, row.subscriber_id, {
      purpose: 'brand_marketing',
      policyVersion: 'customer-opt-out-v1',
      consentText: 'Stop email for this brand.',
      sourceDomain: '',
    });
    await sql.query('UPDATE customer_audience_optouts SET used_at=coalesce(used_at,now()) WHERE id=$1', [id]);
  });
}

async function applyCustomerUnsubscribe(
  sql: Sql,
  workspace: string,
  brand: string,
  subscriber: string,
  p: Policy,
) {
  const person = (
    await sql.query<{ state: string }>('SELECT state FROM subscribers WHERE id=$1 FOR UPDATE', [subscriber])
  ).rows[0];
  if (!person || !['pending', 'confirmed'].includes(person.state)) return;
  await sql.query("UPDATE subscribers SET state='unsubscribed',updated_at=now() WHERE id=$1", [subscriber]);
  await factualEvent(sql, workspace, brand, subscriber, 'unsubscribed', p, 'customer-unsubscribe-link');
  await sql.query(
    "UPDATE customer_audience_confirmations SET state='cancelled',consumed_at=now() WHERE subscriber_id=$1 AND state NOT IN ('confirmed','cancelled')",
    [subscriber],
  );
  await sql.query(
    "UPDATE subscriber_confirmation_tokens SET consumed_at=now() WHERE subscriber_id=$1 AND consumed_at IS NULL AND action='confirm'",
    [subscriber],
  );
  await sql.query(
    "UPDATE subscriber_outbox SET state='cancelled',lease_id=NULL,lease_until=NULL WHERE subscriber_id=$1 AND attempts=0 AND state IN ('pending','leased')",
    [subscriber],
  );
}
