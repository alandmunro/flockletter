import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import pg from 'pg';
import { Webhook } from 'standardwebhooks';
import { startDatabase } from '../scripts/database-fixture.js';
import { consentPolicy, signupAccepted } from '../src/shared/subscriber.js';
import { createApp } from '../src/server/app.js';
import { Authenticator, type IdentityProvider } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { SubscriberIntake, suppress } from '../src/server/subscribers/intake.js';
import { loadIntakeBinding, type IntakeBinding } from '../src/server/subscribers/config.js';
import { actionUrl } from '../src/server/subscribers/tokens.js';
import {
  CapturedConfirmation,
  ResendConfirmation,
  type ConfirmationMessage,
  type ConfirmationProvider,
} from '../src/server/confirmation/provider.js';
import { ConfirmationWorker } from '../src/server/confirmation/worker.js';
import { applyFeedback } from '../src/server/confirmation/feedback.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, admin: pg.Client, server: Server;
let binding: IntakeBinding,
  owner: Actor,
  intake: SubscriberIntake,
  service: CommandService,
  worker: ConfirmationWorker;
let capture: CapturedConfirmation, origin: string, credential: string, removed: boolean;
const email = 'Reader+ffa@example.com',
  second = 'another@example.com';
const isCurrentOwner = async (user: string, w: string) =>
  !removed && user === owner.userId && w === owner.workspaceId;
const form = (address = email) => ({
  email: address,
  purpose: consentPolicy.purpose,
  consentAffirmed: true,
  consentVersion: consentPolicy.version,
  consentText: consentPolicy.text,
  source: 'storefront-footer',
  sourceDomain: 'ffa-staging.example.test',
});
const id = () => randomUUID();
async function rows(sql: string, args: unknown[] = []) {
  return db.brand(binding.workspaceId, binding.brandId, async (conn) => (await conn.query(sql, args)).rows);
}
async function issue(scopes = ['subscriber:signup'], brands = [binding.brandId]) {
  return service.execute(
    'connection.create',
    { name: 'Contract test', scopes, brandIds: brands, expiresInDays: 2, operationKey: id() },
    owner,
  ) as Promise<{ token: string; connection: { id: string } }>;
}
const http = (path: string, options: RequestInit = {}) => fetch(origin + path, options);
const path = () => '/api/v1/brands/' + binding.brandId + '/subscriber-signups';
function post(
  body: unknown = form(),
  key: string = id(),
  token = credential,
  route = path(),
  extra: Record<string, string> = {},
) {
  return http(route, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
      'idempotency-key': key,
      ...extra,
    },
    body: JSON.stringify(body),
  });
}
const action = (kind: string, token: string, from = binding.origin) =>
  http('/subscriptions/' + kind, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: from },
    body: JSON.stringify({ token }),
  });
async function mode(enabled: boolean) {
  return service.execute(
    'intake.configure',
    { brandId: binding.brandId, enabled, operationKey: id() },
    owner,
  );
}
async function delivered() {
  expect(await worker.tick()).toBe(true);
  const message = [...capture.messages.values()][0]!;
  expect(message.to).toBe(email);
  return {
    confirm: new URL(message.confirm).hash.slice(1),
    unsubscribe: new URL(message.unsubscribe).hash.slice(1),
  };
}
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  await db.verifyBoundary();
  admin = new pg.Client({ connectionString: fixture.adminUrl });
  await admin.connect();
});
afterAll(async () => {
  await admin?.end();
  await db?.close();
  await fixture?.stop();
});
beforeEach(async () => {
  removed = false;
  owner = {
    workspaceId: 'org_' + id().replaceAll('-', ''),
    userId: 'test_owner',
    actorId: 'test_owner',
    owner: true,
    kind: 'session',
    scopes: ['read'],
    brandIds: null,
  };
  const setup = new CommandService(db);
  await setup.execute(
    'workspace.initialize',
    { operationKey: id(), name: 'Test workspace', brandName: 'Test brand' },
    owner,
  );
  const workspace = (await setup.execute('workspace.get', {}, owner)) as { brands: { id: string }[] };
  binding = {
    workspaceId: owner.workspaceId,
    brandId: workspace.brands[0]!.id,
    sourceDomain: 'ffa-staging.example.test',
    origin: 'https://intake.example.test',
    mode: 'capture',
    key: randomBytes(32),
    sender: 'sender@example.test',
    recipients: new Set([email, second]),
  };
  intake = new SubscriberIntake(db, binding);
  service = new CommandService(db, intake);
  capture = new CapturedConfirmation();
  worker = new ConfirmationWorker(db, binding, capture, isCurrentOwner);
  await worker.tick();
  await mode(true);
  credential = (await issue()).token;
  const identity: IdentityProvider = {
    session: async () => ({ userId: owner.userId, workspaceId: owner.workspaceId }),
    isOwner: async (user, w) => !removed && user === owner.userId && w === owner.workspaceId,
  };
  const config = loadConfig({
    APP_ENV: 'test',
    APP_ORIGIN: binding.origin,
    DATABASE_URL: fixture.url,
    CLERK_SECRET_KEY: 'test-fixture',
    CLERK_PUBLISHABLE_KEY: 'test-fixture',
  });
  const app = createApp(config, service, new Authenticator(db, identity));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected TCP port');
  origin = 'http://127.0.0.1:' + address.port;
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  vi.restoreAllMocks();
});

describe('FFA first-party subscriber intake', () => {
  it('NL-009/011: the scoped readiness probe checks the source and worker without enrolling anyone', async () => {
    const probe = (site = binding.sourceDomain, token = credential) => http(path(), {
      method: 'HEAD', headers: { authorization: 'Bearer ' + token, 'x-flockletter-source-domain': site },
    });
    const response = await probe();
    expect(response.status).toBe(204);
    expect(response.headers.get('x-flockletter-confirmation-mode')).toBe('capture');
    expect(await rows('SELECT id FROM subscribers')).toEqual([]);
    expect(await rows('SELECT bucket FROM subscriber_rate_buckets')).toEqual([]);
    expect((await probe('wrong.example')).status).toBe(503);
    const other = await issue(['read']);
    expect((await probe(binding.sourceDomain, other.token)).status).toBe(403);
    await mode(false);
    expect((await probe()).status).toBe(503);
    await mode(true);
    await rows("UPDATE subscriber_intake_settings SET heartbeat_at=now()-interval '10 minutes'");
    expect((await probe()).status).toBe(503);
    removed = true;
    expect((await probe()).status).toBe(403);
  });
  it('FI-001/002/003: matches the FFA server contract, atomically deduplicates concurrent contacts and replays', async () => {
    const key = id();
    const results = await Promise.all([
      post(form('  Reader+ffa@EXAMPLE.COM '), key),
      post(form(), key),
      post(),
    ]);
    for (const response of results) {
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(signupAccepted);
    }
    expect((await post(form(second), key)).status).toBe(409);
    expect(await rows('SELECT email_normalized,state,confirmed_at FROM subscribers')).toEqual([
      { email_normalized: email, state: 'pending', confirmed_at: null },
    ]);
    expect(
      await rows('SELECT event,source,source_domain,policy_version FROM subscriber_consent_events'),
    ).toEqual([
      {
        event: 'signup_requested',
        source: 'storefront-footer',
        source_domain: binding.sourceDomain,
        policy_version: consentPolicy.version,
      },
    ]);
    expect(await rows('SELECT response FROM subscriber_signup_operations')).toHaveLength(2);
    expect(await rows('SELECT state FROM subscriber_outbox')).toEqual([{ state: 'pending' }]);
    expect(await rows('SELECT token_hash FROM subscriber_confirmation_tokens')).toHaveLength(2);
    expect(await rows('SELECT replays FROM subscriber_intake_settings')).toEqual([{ replays: '1' }]);
  });
  it('FI-004/009/010: all states have the same response, GET is inert and suppression wins', async () => {
    const first = await post();
    expect(first.status).toBe(202);
    const response = await first.json();
    const link = await delivered();
    expect((await http('/subscriptions/confirm')).status).toBe(200);
    expect((await rows('SELECT state FROM subscribers'))[0]?.state).toBe('pending');
    expect((await action('confirm', link.confirm, 'https://foreign.example')).status).toBe(403);
    expect((await action('unsubscribe', link.confirm)).status).toBe(410);
    expect((await action('confirm', link.confirm.slice(1))).status).toBe(410);
    expect((await action('confirm', link.confirm)).status).toBe(200);
    expect((await action('confirm', link.confirm)).status).toBe(410);
    expect((await rows('SELECT state FROM subscribers'))[0]?.state).toBe('confirmed');
    expect(await (await post()).json()).toEqual(response);
    expect((await action('unsubscribe', link.unsubscribe)).status).toBe(200);
    expect(await (await post()).json()).toEqual(response);
    expect((await rows('SELECT state FROM subscribers'))[0]?.state).toBe('unsubscribed');
    expect(await rows('SELECT event FROM subscriber_consent_events ORDER BY recorded_at')).toEqual([
      { event: 'signup_requested' },
      { event: 'confirmed' },
      { event: 'unsubscribed' },
    ]);
    expect(await rows('SELECT id FROM subscriber_outbox')).toHaveLength(1);
  });
  it('FI-005/012/013: rejects untrusted consent, authority, wrong source, malformed JSON and oversized payloads without echoing data', async () => {
    const forbidden = [
      { consentAffirmed: false },
      { consentAffirmed: undefined },
      { consentText: 'invented' },
      { source: 'purchase' },
      { purpose: 'orders' },
      { sourceDomain: 'foreign.example' },
      { consentVersion: 'unknown' },
      { occurredAt: 'yesterday' },
      { workspaceId: 'other' },
      { email: 'private-bad-address' },
    ];
    for (const fields of forbidden) {
      const r = await post({ ...form(), ...fields });
      expect(r.status).toBe(422);
      expect(await r.text()).not.toContain('private-bad-address');
    }
    const raw = (body: string, token = credential) =>
      http(path(), {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'idempotency-key': id(),
        },
        body,
      });
    expect((await raw('{invalid')).status).toBe(400);
    expect((await raw(JSON.stringify({ private: 'x'.repeat(9000) }))).status).toBe(413);
    expect((await raw('x'.repeat(10000), 'no-access')).status).toBe(401);
    expect((await post(form(), id(), credential, path(), { origin: binding.origin })).status).toBe(403);
    expect((await post(form(), 'short')).status).toBe(422);
    expect(await rows('SELECT id FROM subscribers')).toHaveLength(0);
  });
  it('FI-006/007: denies mismatched brands, mixed scopes, read tokens, expired/revoked tokens, and revoked issuer membership', async () => {
    const read = await issue(['read']);
    expect((await post(form(), id(), read.token)).status).toBe(403);
    expect(
      (await post(form(), id(), credential, '/api/v1/brands/' + id() + '/subscriber-signups')).status,
    ).toBe(404);
    expect(
      (await http('/api/v1/schema', { headers: { authorization: 'Bearer ' + credential } })).status,
    ).toBe(403);
    expect((await post({}, id(), credential, '/api/v1/commands/workspace.get')).status).toBe(403);
    await expect(issue(['read', 'subscriber:signup'])).rejects.toMatchObject({
      code: 'invalid_intake_grant',
    });
    removed = true;
    expect((await post()).status).toBe(403);
    removed = false;
    const doomed = await issue();
    await service.execute('connection.revoke', { id: doomed.connection.id, operationKey: id() }, owner);
    expect((await post(form(), id(), doomed.token)).status).toBe(401);
    const expired = await issue();
    await db.tenant(binding.workspaceId, (conn) =>
      conn.query("UPDATE connections SET expires_at=now()-interval '1 minute' WHERE id=$1", [
        expired.connection.id,
      ]),
    );
    expect((await post(form(), id(), expired.token)).status).toBe(401);
  });
  it('FI-006: forced brand/workspace RLS, foreign keys and append-only evidence hold under direct runtime SQL', async () => {
    await post();
    const other = id();
    await admin.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      binding.workspaceId,
      other,
      'Other brand',
    ]);
    expect(
      await db.brand(
        binding.workspaceId,
        other,
        async (sql) => (await sql.query('SELECT id FROM subscribers')).rows,
      ),
    ).toEqual([]);
    expect(
      await db.brand(
        'org_foreign',
        binding.brandId,
        async (sql) => (await sql.query('SELECT id FROM subscribers')).rows,
      ),
    ).toEqual([]);
    expect(
      await db.tenant(
        binding.workspaceId,
        async (sql) => (await sql.query('SELECT id FROM subscribers')).rows,
      ),
    ).toEqual([]);
    await expect(
      db.brand(binding.workspaceId, other, (sql) =>
        sql.query(
          'INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,$5)',
          [binding.workspaceId, binding.brandId, id(), email, 'confirmed'],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const person = (await rows('SELECT id FROM subscribers'))[0]!.id;
    await expect(
      db.brand(binding.workspaceId, other, (sql) =>
        sql.query(
          "INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain) VALUES($1,$2,$3,$4,'confirmed','p','v','digest','source','test')",
          [binding.workspaceId, other, id(), person],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(rows("UPDATE subscriber_consent_events SET source='wrong'")).rejects.toMatchObject({
      code: '42501',
    });
    await expect(rows('DELETE FROM subscriber_consent_events')).rejects.toMatchObject({ code: '42501' });
  });
  it('FI-008: failure writing the outbox rolls the contact, consent, tokens and operation back together', async () => {
    await admin.query(
      "CREATE FUNCTION test_reject_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$",
    );
    await admin.query(
      'CREATE TRIGGER test_reject_job BEFORE INSERT ON subscriber_outbox FOR EACH ROW EXECUTE FUNCTION test_reject_job()',
    );
    const key = id();
    try {
      const r = await post(form(), key);
      expect(r.status).toBe(500);
      expect(await r.text()).not.toContain(email);
    } finally {
      await admin.query('DROP TRIGGER test_reject_job ON subscriber_outbox');
    }
    for (const table of [
      'subscribers',
      'subscriber_consent_events',
      'subscriber_confirmation_tokens',
      'subscriber_signup_operations',
      'subscriber_outbox',
    ])
      expect(await rows('SELECT * FROM ' + table)).toEqual([]);
    expect((await post(form(), key)).status).toBe(202);
  });
  it('FI-008: ambiguous acceptance reconciles with the same provider operation and unchanged payload', async () => {
    await post();
    const effects = new Map<string, ConfirmationMessage>();
    const calls: string[] = [];
    const provider: ConfirmationProvider = {
      mode: 'capture',
      async deliver(key, msg) {
        calls.push(key);
        if (!effects.has(key)) {
          effects.set(key, msg);
          throw Error('private provider detail');
        }
        expect(msg).toEqual(effects.get(key));
        return { kind: 'captured', id: key };
      },
    };
    const dispatcher = new ConfirmationWorker(db, binding, provider, isCurrentOwner);
    await dispatcher.tick();
    expect((await rows('SELECT state,uncertain FROM subscriber_outbox'))[0]).toEqual({
      state: 'pending',
      uncertain: true,
    });
    await rows("UPDATE subscriber_outbox SET next_attempt_at=now()-interval '1 minute'");
    await Promise.all([dispatcher.tick(), dispatcher.tick()]);
    expect(calls).toHaveLength(2);
    expect(effects.size).toBe(1);
    expect((await rows('SELECT state FROM subscriber_outbox'))[0]?.state).toBe('captured');
    expect(JSON.stringify(await rows('SELECT * FROM subscriber_outbox'))).not.toContain(email);
  });
  it('FI-008: expired leases outside the provider replay window become visible unknown outcomes without another send', async () => {
    await post();
    await rows(
      "UPDATE subscriber_outbox SET state='leased',attempts=1,first_attempt_at=now()-interval '25 hours',lease_until=now()-interval '1 minute'",
    );
    await worker.tick();
    expect(capture.messages.size).toBe(0);
    expect(await rows('SELECT state,error_category FROM subscriber_outbox')).toEqual([
      { state: 'unknown', error_category: 'reconciliation_required' },
    ]);
    expect((await worker.alerts()).unresolved).toBe(1);
  });
  it('FI-009/010: expiry, old links, complaint and bounce prevent later confirmation or re-enrollment', async () => {
    await post();
    const link = await delivered();
    await rows(
      "UPDATE subscriber_confirmation_tokens SET expires_at=now()-interval '1 second' WHERE action='confirm'",
    );
    expect((await action('confirm', link.confirm)).status).toBe(410);
    await rows("UPDATE subscriber_confirmation_tokens SET issued_at=now()-interval '25 hours'");
    expect((await post()).status).toBe(202);
    expect(await rows('SELECT id FROM subscriber_outbox')).toHaveLength(2);
    const t = (
      await rows(
        "SELECT * FROM subscriber_confirmation_tokens WHERE action='confirm' ORDER BY issued_at DESC",
      )
    )[0]!;
    const latest = new URL(actionUrl(binding, 'confirm', t.id)).hash.slice(1);
    await db.brand(binding.workspaceId, binding.brandId, (sql) =>
      suppress(sql, t.subscriber_id, t.request_event_id, 'hard_bounced'),
    );
    expect(await (await post()).json()).toEqual(signupAccepted);
    expect((await action('confirm', latest)).status).toBe(410);
    await db.brand(binding.workspaceId, binding.brandId, (sql) =>
      suppress(sql, t.subscriber_id, t.request_event_id, 'complained'),
    );
    await action('unsubscribe', link.unsubscribe);
    expect((await rows('SELECT state FROM subscribers'))[0]?.state).toBe('complained');
    expect(await (await post()).json()).toEqual(signupAccepted);
    expect(await rows('SELECT id FROM subscriber_outbox')).toHaveLength(2);
  });
  it('FI-011/015: off, stale worker, missing provider, unapproved recipients and paused brands fail closed', async () => {
    expect(loadIntakeBinding(loadConfig({ APP_ENV: 'test' }), {})).toBeUndefined();
    expect((await post(form('unlisted@example.com'))).status).toBe(503);
    await mode(false);
    expect((await post()).status).toBe(503);
    await mode(true);
    await rows("UPDATE subscriber_intake_settings SET heartbeat_at=now()-interval '10 minutes'");
    expect((await post()).status).toBe(503);
    expect((await http('/readyz')).status).toBe(200);
    expect((await (await http('/readyz')).json()).sendingEnabled).toBe(false);
    expect((await post({}, id(), credential, '/api/v1/commands/campaign.send')).status).toBe(404);
  });
  it('FI-012: limits are durable across credentials and resubmissions cannot bomb one mailbox', async () => {
    const another = await issue();
    for (let i = 0; i < 30; i++) expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(429);
    for (let i = 0; i < 29; i++) expect((await post(form(), id(), another.token)).status).toBe(202);
    expect((await post(form(), id(), another.token)).status).toBe(429);
    expect(await rows('SELECT id FROM subscriber_outbox')).toHaveLength(1);
  });
  it('FI-012: each rate window keeps its allowance until its full duration has elapsed', async () => {
    expect((await post()).status).toBe(202);
    for (const [bucket, limit, recentAge, expiredAge] of [
      ['brand-minute', 60, '15 seconds', '61 seconds'],
      ['brand-day', 1000, '2 hours', '25 hours'],
    ] as const) {
      // Offset from the boundary so the old calendar-based reset fails at every time of day.
      const window = await rows(
        `UPDATE subscriber_rate_buckets SET requests=$2,
          window_at=date_trunc('second', clock_timestamp()) - $3::interval - interval '250 milliseconds'
          WHERE bucket=$1 RETURNING window_at`,
        [bucket, limit, recentAge],
      );
      expect(window).toHaveLength(1);
      expect((await post()).status).toBe(429);
      const afterRejection = await rows('SELECT window_at FROM subscriber_rate_buckets WHERE bucket=$1', [bucket]);
      expect(afterRejection).toEqual(window);
      await rows('UPDATE subscriber_rate_buckets SET window_at=clock_timestamp()-$2::interval WHERE bucket=$1', [
        bucket, expiredAge,
      ]);
      expect((await post()).status).toBe(202);
      const afterExpiry = await rows('SELECT requests FROM subscriber_rate_buckets WHERE bucket=$1', [bucket]);
      expect(afterExpiry).toEqual([{ requests: 1 }]);
    }
    expect(await rows('SELECT id FROM subscriber_outbox')).toHaveLength(1);
  });
  it('FI-013: only a signed feedback event tied to this delivery can suppress; replay and soft bounce are harmless', async () => {
    const key = 'whsec_' + randomBytes(32).toString('base64');
    const live = { ...binding, mode: 'live' as const, webhookSecret: key };
    const liveIntake = new SubscriberIntake(db, live);
    const provider: ConfirmationProvider = {
      mode: 'live',
      async deliver() {
        return { kind: 'accepted', id: providerId };
      },
    };
    const providerId = id();
    const dispatch = new ConfirmationWorker(db, live, provider, isCurrentOwner);
    await dispatch.tick();
    const actor: Actor = {
      ...owner,
      kind: 'connection',
      actorId:
        'connection:' +
        (await rows("SELECT id FROM connections WHERE scopes=ARRAY['subscriber:signup']"))[0]!.id,
      scopes: ['subscriber:signup'],
      brandIds: [binding.brandId],
    };
    await liveIntake.signup(actor, binding.brandId, id(), form());
    await dispatch.tick();
    const job = (await rows('SELECT id FROM subscriber_outbox'))[0]!.id;
    const make = (type: string, hard: string, eventId: string) => {
      const raw = Buffer.from(
        JSON.stringify({
          type,
          data: { email_id: providerId, tags: { flockletter_job: job }, bounce: { type: hard } },
        }),
      );
      const date = new Date();
      return {
        raw,
        headers: {
          'webhook-id': eventId,
          'webhook-timestamp': String(Math.floor(date.getTime() / 1000)),
          'webhook-signature': new Webhook(key).sign(eventId, date, raw),
        },
      };
    };
    const soft = make('email.bounced', 'Transient', 'msg_soft');
    await applyFeedback(liveIntake, soft.raw, soft.headers);
    expect((await rows('SELECT state FROM subscribers'))[0]?.state).toBe('pending');
    const hard = make('email.bounced', 'Permanent', 'msg_hard');
    await expect(applyFeedback(liveIntake, Buffer.from('{}'), hard.headers)).rejects.toMatchObject({
      code: 'invalid_signature',
    });
    await applyFeedback(liveIntake, hard.raw, hard.headers);
    await applyFeedback(liveIntake, hard.raw, hard.headers);
    const complaint = make('email.complained', '', 'msg_complaint');
    await applyFeedback(liveIntake, complaint.raw, complaint.headers);
    expect((await rows('SELECT state FROM subscribers'))[0]?.state).toBe('complained');
    expect(await rows('SELECT event_id FROM subscriber_feedback')).toHaveLength(2);
  });
  it('uses stable provider keys, a bounded timeout and a fixed HTTPS destination without exposing provider error bodies', async () => {
    const sender = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: id() }))
      .mockResolvedValueOnce(Response.json({ private: email }, { status: 500 }));
    const adapter = new ResendConfirmation('fake-test-only', sender);
    const message = {
      to: email,
      from: 'sender@example.test',
      confirm: 'https://example.test/confirm#secret',
      unsubscribe: 'https://example.test/unsubscribe#secret',
    };
    const job = id();
    expect((await adapter.deliver(job, message)).kind).toBe('accepted');
    expect(await adapter.deliver(job, message)).toEqual({ kind: 'ambiguous' });
    expect(sender.mock.calls[0]?.[0]).toBe('https://api.resend.com/emails');
    expect(sender.mock.calls[1]?.[1]?.body).toBe(sender.mock.calls[0]?.[1]?.body);
    expect(new Headers(sender.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe(
      'ffa-confirmation/' + job,
    );
  });
  it('blocks readiness when the subscriber brand policy is absent or an additional permissive policy exists', async () => {
    await admin.query('CREATE POLICY unsafe_fixture ON subscribers USING (true)');
    try {
      await expect(db.verifyBoundary()).rejects.toThrow('workspace and brand policies');
      expect((await http('/readyz')).status).toBe(503);
    } finally {
      await admin.query('DROP POLICY unsafe_fixture ON subscribers');
    }
    await admin.query('ALTER TABLE subscribers NO FORCE ROW LEVEL SECURITY');
    try {
      await expect(db.verifyBoundary()).rejects.toThrow('forced tenant policies');
    } finally {
      await admin.query('ALTER TABLE subscribers FORCE ROW LEVEL SECURITY');
    }
    await db.verifyBoundary();
  });
  it('rejects a wrong-brand signed link and preserves opt-out even when intake and delivery are turned off', async () => {
    await post();
    const link = await delivered();
    const foreign = new SubscriberIntake(db, { ...binding, brandId: id() });
    await expect(foreign.act('confirm', link.confirm)).rejects.toMatchObject({ status: 410 });
    await mode(false);
    const stopped = new SubscriberIntake(db, undefined, binding);
    await expect(stopped.act('confirm', link.confirm)).rejects.toMatchObject({ status: 503 });
    await expect(stopped.act('unsubscribe', link.unsubscribe)).resolves.toEqual({ status: 'unsubscribed' });
    await mode(true);
    expect(await (await post()).json()).toEqual(signupAccepted);
    expect((await rows('SELECT state FROM subscribers'))[0]?.state).toBe('unsubscribed');
  });
  it('honors a pending recipient opt-out before an outbox provider can be called', async () => {
    await post();
    const job = (await rows('SELECT unsubscribe_id FROM subscriber_outbox'))[0]!;
    const cancel = new URL(actionUrl(binding, 'unsubscribe', job.unsubscribe_id)).hash.slice(1);
    expect((await action('unsubscribe', cancel)).status).toBe(200);
    expect(await worker.tick()).toBe(false);
    expect(capture.messages.size).toBe(0);
    expect(await rows('SELECT state FROM subscriber_outbox')).toEqual([{ state: 'cancelled' }]);
  });
  it('honors concurrent owner opt-outs at the operation cap and cancels an undispatched confirmation', async () => {
    expect((await post()).status).toBe(202);
    const person = (await rows('SELECT id FROM subscribers'))[0]!.id;
    const input = { brandId: binding.brandId, id: person };
    for (const name of ['audience.summary', 'audience.list', 'audience.contact', 'audience.unsubscribe']) {
      expect((await post(input, id(), credential, '/api/v1/commands/' + name)).status).toBe(403);
    }
    await db.tenant(binding.workspaceId, sql => sql.query(
      "INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) SELECT $1,'fixture',i::text,'fixture','{}'::jsonb FROM generate_series(1,2000) i",
      [binding.workspaceId],
    ));
    await expect(mode(true)).rejects.toMatchObject({ code: 'preparation_limit' });
    const receipts = await Promise.all([1, 2].map(() => service.execute('audience.unsubscribe', input, owner)));
    expect(receipts).toEqual([{ id: person, suppressed: true }, { id: person, suppressed: true }]);
    expect(await rows('SELECT state FROM subscriber_outbox')).toEqual([{ state: 'cancelled' }]);
    expect(await rows("SELECT id FROM subscriber_confirmation_tokens WHERE action='confirm' AND consumed_at IS NULL")).toEqual([]);
    expect(await (await post()).json()).toEqual(signupAccepted);
    expect(await worker.tick()).toBe(false);
    expect(capture.messages.size).toBe(0);
    expect(await rows('SELECT event,source FROM subscriber_consent_events ORDER BY recorded_at')).toEqual([
      { event: 'signup_requested', source: 'storefront-footer' }, { event: 'unsubscribed', source: 'workspace-owner' },
    ]);
    expect(await rows('SELECT resource_id FROM audit WHERE action=$1',['audience.unsubscribe'])).toEqual([{ resource_id: person }]);
  });
  it('keeps a confirmed owner opt-out effective with intake paused and across repeat signups', async () => {
    await post();
    const link = await delivered();
    expect((await action('confirm', link.confirm)).status).toBe(200);
    await mode(false);
    const person = (await rows('SELECT id FROM subscribers'))[0]!.id;
    await service.execute('audience.unsubscribe', { brandId: binding.brandId, id: person }, owner);
    await mode(true);
    await Promise.all([post(), action('unsubscribe', link.unsubscribe)]);
    expect(await rows('SELECT state FROM subscribers')).toEqual([{ state: 'unsubscribed' }]);
    expect(await rows('SELECT source FROM subscriber_consent_events WHERE event=$1', ['unsubscribed'])).toEqual([{ source: 'workspace-owner' }]);
    expect(await worker.tick()).toBe(false);
    expect(capture.messages.size).toBe(1);
  });
  it('allows an owner to pause intake when the workspace preparation operation limit has been reached', async () => {
    await db.tenant(binding.workspaceId, (sql) =>
      sql.query(
        "INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) SELECT $1,'fixture',i::text,'fixture','{}'::jsonb FROM generate_series(1,2000) i",
        [binding.workspaceId],
      ),
    );
    await mode(false);
    expect((await post()).status).toBe(503);
    await expect(mode(true)).rejects.toMatchObject({ code: 'preparation_limit' });
  });
  it('isolates the signup network limit from unrelated workspace operations', async () => {
    let response: Response | undefined;
    for (let i = 0; i < 121; i++) response = await post(form(), id(), 'invalid');
    expect(response?.status).toBe(429);
    expect((await post({}, id(), 'ordinary-test-session', '/api/v1/commands/workspace.get')).status).toBe(
      200,
    );
  });
  it.each(['issuer', 'connection'])(
    'rechecks %s revocation after acceptance and before confirmation dispatch',
    async (kind) => {
      await post();
      if (kind === 'issuer') removed = true;
      else
        await rows(
          'UPDATE connections SET revoked_at=now() WHERE id=(SELECT connection_id FROM subscriber_outbox)',
        );
      await worker.tick();
      expect(capture.messages.size).toBe(0);
      expect(await rows('SELECT state FROM subscriber_outbox')).toEqual([{ state: 'cancelled' }]);
      expect((await rows('SELECT state FROM subscribers'))[0]?.state).toBe('pending');
    },
  );
  it('keeps private intake data and token material out of error responses and application diagnostics', async () => {
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    await post();
    const { confirm } = await delivered();
    const digest = (
      await rows("SELECT token_hash FROM subscriber_confirmation_tokens WHERE action='confirm'")
    )[0]!.token_hash;
    const bad = await post({ ...form(), consentAffirmed: false });
    const text = await bad.text();
    const diagnostics = JSON.stringify(logs.map((spy) => spy.mock.calls)) + text;
    for (const secret of [email, credential, confirm, digest, consentPolicy.text])
      expect(diagnostics).not.toContain(secret);
    const landing = await http('/subscriptions/confirm');
    expect(landing.headers.get('referrer-policy')).toBe('no-referrer');
    expect(landing.headers.get('cache-control')).toBe('no-store');
    expect(await landing.text()).not.toContain(confirm);
  });
});
