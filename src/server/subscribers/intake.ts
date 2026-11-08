import { createHmac, randomUUID } from 'node:crypto';
import {
  consentPolicy,
  intakeKey,
  signupAccepted,
  signupInput,
  type IntakeStatus,
  type SignupInput,
} from '../../shared/subscriber.js';
import { Database, type Sql } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import type { Actor } from '../service.js';
import { fingerprint, type IntakeBinding, type LinkBinding } from './config.js';
import { actionToken, hash, verifiedId, type LinkAction } from './tokens.js';

const unavailable = () =>
  new AppError(503, 'intake_unavailable', 'Subscriber intake is currently unavailable.');
export function authorizeIntake(actor: Actor, brand: string) {
  requireCondition(
    actor.kind === 'connection' && actor.scopes.length === 1 && actor.scopes[0] === 'subscriber:signup',
    403,
    'intake_scope_required',
    'A dedicated subscriber intake connection is required.',
  );
  requireCondition(
    actor.brandIds?.length === 1 && actor.brandIds[0] === brand,
    404,
    'brand_unavailable',
    'The requested brand is unavailable.',
  );
}
type Gate = { enabled: boolean; worker_fingerprint: string | null; fresh: boolean };
async function gate(sql: Sql, lock = false) {
  return (
    await sql.query<Gate>(`SELECT enabled,worker_fingerprint,heartbeat_at > clock_timestamp()-interval '2 minutes' AS fresh
    FROM subscriber_intake_settings ${lock ? 'FOR UPDATE' : ''}`)
  ).rows[0];
}
function ready(g: Gate | undefined, binding: IntakeBinding | undefined) {
  return Boolean(binding && g?.fresh && g.worker_fingerprint === fingerprint(binding));
}
async function bump(
  sql: Sql,
  workspaceId: string,
  brandId: string,
  name: string,
  duration: '1 minute' | '24 hours',
  limit: number,
) {
  const r = await sql.query<{ requests: number }>(
    `INSERT INTO subscriber_rate_buckets AS bucket(workspace_id,brand_id,bucket,window_at,requests)
    VALUES($1,$2,$3,clock_timestamp(),1) ON CONFLICT(workspace_id,brand_id,bucket) DO UPDATE SET
    requests=CASE WHEN excluded.window_at >= bucket.window_at + $4::interval THEN 1
                 ELSE least(bucket.requests+1,$5+1) END,
    window_at=CASE WHEN excluded.window_at >= bucket.window_at + $4::interval THEN excluded.window_at
                  ELSE bucket.window_at END
    RETURNING requests`,
    [workspaceId, brandId, name, duration, limit],
  );
  return r.rows[0]!.requests <= limit;
}
export async function recordTransition(
  sql: Sql,
  eventId: string,
  event: 'confirmed' | 'unsubscribed' | 'suppressed',
  source: string,
) {
  await sql.query(
    `INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain)
    SELECT workspace_id,brand_id,$2,subscriber_id,$3,purpose,policy_version,text_digest,$4,source_domain
    FROM subscriber_consent_events WHERE id=$1`,
    [eventId, randomUUID(), event, source],
  );
}
export async function suppress(
  sql: Sql,
  subscriberId: string,
  evidenceId: string | null,
  state: 'unsubscribed' | 'hard_bounced' | 'complained',
  source: string = state,
) {
  const update = await sql.query(
    `UPDATE subscribers SET state=$2,updated_at=now() WHERE id=$1 AND state<>$2
    AND state<>'complained' AND (state<>'hard_bounced' OR $2='complained') RETURNING id`,
    [subscriberId, state],
  );
  if (!update.rowCount) return;
  await sql.query(
    "UPDATE subscriber_confirmation_tokens SET consumed_at=now() WHERE subscriber_id=$1 AND consumed_at IS NULL AND action='confirm'",
    [subscriberId],
  );
  await sql.query(
    "UPDATE subscriber_outbox SET state='cancelled',lease_id=NULL,lease_until=NULL WHERE subscriber_id=$1 AND state IN ('pending','leased') AND attempts=0",
    [subscriberId],
  );
  if (evidenceId) {
    await recordTransition(sql, evidenceId, state === 'unsubscribed' ? 'unsubscribed' : 'suppressed', source);
  } else {
    if ((source === 'campaign-feedback_test' || source === 'campaign-ses_simulator') &&
        (state === 'hard_bounced' || state === 'complained')) {
      // A verified negative event is evidence of suppression, never evidence of original consent.
      await sql.query(`INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain)
        SELECT workspace_id,brand_id,$2,id,'suppressed','brand_marketing','campaign-feedback-v1',$3,$4,''
        FROM subscribers WHERE id=$1`,[subscriberId,randomUUID(),hash('Provider reported '+state+' for the reviewed address.'),source]);
      return;
    }
    // Preserve a factual opt-out for a legacy contact whose signup evidence is unavailable.
    if (state !== 'unsubscribed' || !['workspace-owner', 'marketing-unsubscribe-link'].includes(source)) {
      throw new Error('A source consent event is required.');
    }
    const ownerAction = source === 'workspace-owner';
    await sql.query(
      `INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain)
      SELECT workspace_id,brand_id,$2,id,'unsubscribed','brand_marketing',$3,$4,$5,''
      FROM subscribers WHERE id=$1`,
      [subscriberId, randomUUID(), ownerAction ? 'owner-opt-out-v1' : 'marketing-opt-out-v1',
        hash(ownerAction ? 'Stop marketing to this contact for this brand.' : 'Unsubscribe from marketing email from this brand.'), source],
    );
  }
}

export class SubscriberIntake {
  constructor(
    readonly db: Database,
    readonly binding?: IntakeBinding,
    private readonly links: LinkBinding | undefined = binding,
  ) {}
  forBrand(workspace: string, brand: string) {
    return this.binding?.workspaceId === workspace && this.binding.brandId === brand
      ? this.binding
      : undefined;
  }
  async probe(actor: Actor, brand: string, sourceDomain: string | undefined) {
    authorizeIntake(actor, brand);
    const binding = this.forBrand(actor.workspaceId, brand);
    if (!binding || binding.sourceDomain !== sourceDomain) throw unavailable();
    const settings = await this.db.brand(actor.workspaceId, brand, sql => gate(sql));
    if (!settings?.enabled || !ready(settings, binding)) throw unavailable();
    return binding.mode;
  }
  async status(sql: Sql, actor: Actor, brand: string): Promise<IntakeStatus> {
    await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand]);
    const binding = this.forBrand(actor.workspaceId, brand);
    const settings = await gate(sql);
    const people = (
      await sql.query(
        "SELECT count(*) FILTER(WHERE state='pending')::int AS pending,count(*) FILTER(WHERE state='confirmed')::int AS confirmed FROM subscribers",
      )
    ).rows[0];
    const jobs = (
      await sql.query(`SELECT count(*) FILTER(WHERE state IN ('pending','leased'))::int AS queued,
      count(*) FILTER(WHERE state='unknown')::int AS unknown,count(*) FILTER(WHERE state='failed')::int AS failed,
      count(*) FILTER(WHERE state='captured')::int AS captured,count(*) FILTER(WHERE state='delivered_to_provider')::int AS delivered FROM subscriber_outbox`)
    ).rows[0];
    const counters = (
      await sql.query(
        'SELECT accepted::float8,replays::float8,throttled::float8,rejected::float8 FROM subscriber_intake_settings',
      )
    ).rows[0];
    return {
      ready: ready(settings, binding),
      enabled: settings?.enabled ?? false,
      mode: binding?.mode ?? 'off',
      sourceDomain: binding?.sourceDomain ?? null,
      counts: { accepted: 0, replays: 0, throttled: 0, rejected: 0, ...people, ...jobs, ...counters },
    };
  }
  async configure(sql: Sql, actor: Actor, brand: string, enabled: boolean) {
    const view = await this.status(sql, actor, brand);
    if (enabled && !view.ready) throw unavailable();
    await sql.query(
      `INSERT INTO subscriber_intake_settings(workspace_id,brand_id,enabled) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id,brand_id) DO UPDATE SET enabled=excluded.enabled`,
      [actor.workspaceId, brand, enabled],
    );
    return this.status(sql, actor, brand);
  }
  async signup(actor: Actor, brand: string, key: unknown, body: unknown) {
    authorizeIntake(actor, brand);
    const binding = this.forBrand(actor.workspaceId, brand);
    if (!binding) throw unavailable();
    const parsed = signupInput.safeParse(body);
    const operation = intakeKey.safeParse(key);
    const outcome = await this.db.brand(actor.workspaceId, brand, async (sql) => {
      const current = await sql.query(
        `SELECT id FROM connections WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()
        AND scopes=ARRAY['subscriber:signup']::text[] AND brand_ids=ARRAY[$2::uuid] FOR SHARE`,
        [actor.actorId.replace(/^connection:/, ''), brand],
      );
      requireCondition(current.rowCount, 401, 'invalid_connection', 'The connection is unavailable.');
      const g = await gate(sql, true);
      if (!g?.enabled || !ready(g, binding)) throw unavailable();
      const w = actor.workspaceId,
        credential = current.rows[0]!.id;
      const c = await bump(sql, w, brand, 'credential:' + credential, '1 minute', 30);
      const b = await bump(sql, w, brand, 'brand-minute', '1 minute', 60);
      const d = await bump(sql, w, brand, 'brand-day', '24 hours', 1000);
      if (!c || !b || !d) {
        await sql.query('UPDATE subscriber_intake_settings SET throttled=throttled+1');
        return 'limited';
      }
      if (!operation.success || !parsed.success || parsed.data.sourceDomain !== binding.sourceDomain) {
        await sql.query('UPDATE subscriber_intake_settings SET rejected=rejected+1');
        return 'invalid';
      }
      const input = parsed.data;
      if (!binding.recipients.has(input.email)) return 'unavailable';
      const requestDigest = createHmac('sha256', binding.key).update(JSON.stringify(input)).digest('hex');
      const previous = (
        await sql.query<{ request_digest: string; response: typeof signupAccepted }>(
          'SELECT request_digest,response FROM subscriber_signup_operations WHERE connection_id=$1 AND operation_key=$2',
          [credential, operation.data],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_digest !== requestDigest) {
          await sql.query('UPDATE subscriber_intake_settings SET rejected=rejected+1');
          return 'conflict';
        }
        await sql.query('UPDATE subscriber_intake_settings SET replays=replays+1');
        return previous.response;
      }
      await sql.query("DELETE FROM subscriber_signup_operations WHERE created_at<now()-interval '7 days'");
      await this.requestConfirmation(sql, binding, input, credential);
      await sql.query(
        'INSERT INTO subscriber_signup_operations(workspace_id,brand_id,connection_id,operation_key,request_digest,response) VALUES($1,$2,$3,$4,$5,$6)',
        [w, brand, credential, operation.data, requestDigest, JSON.stringify(signupAccepted)],
      );
      await sql.query('UPDATE subscriber_intake_settings SET accepted=accepted+1');
      return signupAccepted;
    });
    if (outcome === 'limited')
      throw new AppError(429, 'intake_rate_limited', 'Too many requests. Try again later.');
    if (outcome === 'conflict')
      throw new AppError(409, 'operation_conflict', 'This operation key was used with different input.');
    if (outcome === 'invalid')
      throw new AppError(
        422,
        'invalid_signup',
        'Review the signup fields, consent policy and operation key.',
      );
    if (outcome === 'unavailable') throw unavailable();
    return outcome;
  }
  private async requestConfirmation(sql: Sql, b: IntakeBinding, input: SignupInput, connectionId: string) {
    await sql.query(
      `INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,'pending')
      ON CONFLICT(workspace_id,brand_id,email_normalized) DO NOTHING`,
      [b.workspaceId, b.brandId, randomUUID(), input.email],
    );
    const person = (
      await sql.query('SELECT id,state FROM subscribers WHERE email_normalized=$1 FOR UPDATE', [input.email])
    ).rows[0]!;
    if (person.state !== 'pending') return;
    const history = (
      await sql.query(
        `SELECT count(*)::int AS week,bool_or(issued_at>now()-interval '24 hours') AS recent
      FROM subscriber_confirmation_tokens WHERE subscriber_id=$1 AND action='confirm' AND issued_at>now()-interval '7 days'`,
        [person.id],
      )
    ).rows[0]!;
    if (history.recent || history.week >= 3) return;
    const evidence = randomUUID(),
      confirm = randomUUID(),
      unsubscribe = randomUUID();
    await sql.query(
      `INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain)
      VALUES($1,$2,$3,$4,'signup_requested',$5,$6,$7,$8,$9)`,
      [
        b.workspaceId,
        b.brandId,
        evidence,
        person.id,
        input.purpose,
        input.consentVersion,
        hash(consentPolicy.text),
        input.source,
        input.sourceDomain,
      ],
    );
    await sql.query(
      "UPDATE subscriber_confirmation_tokens SET consumed_at=now() WHERE subscriber_id=$1 AND action='confirm' AND consumed_at IS NULL",
      [person.id],
    );
    for (const [action, id] of [
      ['confirm', confirm],
      ['unsubscribe', unsubscribe],
    ] as const) {
      await sql.query(
        `INSERT INTO subscriber_confirmation_tokens(workspace_id,brand_id,id,subscriber_id,request_event_id,action,token_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6='confirm' THEN now()+interval '24 hours' ELSE NULL END)`,
        [b.workspaceId, b.brandId, id, person.id, evidence, action, hash(actionToken(b, action, id))],
      );
    }
    await sql.query(
      `INSERT INTO subscriber_outbox(workspace_id,brand_id,id,subscriber_id,token_id,unsubscribe_id,mode,connection_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [b.workspaceId, b.brandId, randomUUID(), person.id, confirm, unsubscribe, b.mode, connectionId],
    );
  }
  async act(action: LinkAction, token: string) {
    const b = this.links;
    if (!b) throw unavailable();
    const id = verifiedId(b, action, token);
    const invalid = () =>
      new AppError(410, 'link_unavailable', 'This link is invalid, expired or already used.');
    if (!id) throw invalid();
    const ok = await this.db.brand(b.workspaceId, b.brandId, async (sql) => {
      const link = (
        await sql.query(
          'SELECT subscriber_id,request_event_id FROM subscriber_confirmation_tokens WHERE id=$1 AND action=$2 AND token_hash=$3',
          [id, action, hash(token)],
        )
      ).rows[0];
      if (!link) return false;
      const g = await gate(sql, true);
      if (action === 'confirm' && (!this.binding || !g?.enabled)) throw unavailable();
      const person = (
        await sql.query('SELECT id,state FROM subscribers WHERE id=$1 FOR UPDATE', [link.subscriber_id])
      ).rows[0];
      if (!person) return false;
      const used = await sql.query(
        `UPDATE subscriber_confirmation_tokens SET attempts=attempts+1,consumed_at=now()
        WHERE id=$1 AND consumed_at IS NULL AND attempts<5 AND (expires_at IS NULL OR expires_at>clock_timestamp()) RETURNING id`,
        [id],
      );
      if (!used.rowCount) return false;
      if (action === 'unsubscribe') {
        await suppress(sql, person.id, link.request_event_id, 'unsubscribed');
      } else {
        if (person.state !== 'pending') return false;
        await sql.query(
          "UPDATE subscribers SET state='confirmed',confirmed_at=now(),updated_at=now() WHERE id=$1",
          [person.id],
        );
        await recordTransition(sql, link.request_event_id, 'confirmed', 'confirmation-link');
      }
      return true;
    });
    if (!ok) throw invalid();
    return { status: action === 'confirm' ? 'confirmed' : 'unsubscribed' };
  }
}
