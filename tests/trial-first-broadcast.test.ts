import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { startBillingFixture } from './helpers/billing-fixture.js';
import { simulatedTrialProvider } from './helpers/trial-provider.js';
import { CommandService } from '../src/server/service.js';
import { TrialRegistry } from '../src/server/customer-abuse/registry.js';
import { CustomerBilling, customerContactLimit, customerEligibility } from '../src/server/customer-billing/service.js';
import { CustomerAudience, createCustomerOptOut } from '../src/server/customer-audience/service.js';
import { CustomerDelivery } from '../src/server/customer-delivery/service.js';
import { SendingSafeguards } from '../src/server/customer-delivery/safeguards.js';
import { ResendSenderSetup, capturedSenderSetupPort } from '../src/server/customer-delivery/sender-setup.js';
import type { Campaign, Workspace } from '../src/shared/contracts.js';
import type { CustomerBillingStatus, TrialReview } from '../src/shared/customer-billing.js';
import type { DeliveryView } from '../src/shared/customer-delivery.js';
import type { CustomerCampaignPreflight } from '../src/shared/customer-preflight.js';
import type { SenderSetupView } from '../src/shared/sender-setup.js';

// CI checks the exact audience and first paced receipt. The optional full drain
// reuses the captured queue locally. "volume" measures persistence throughput
// without the capture transport's one-second pacing; "paced" keeps that pacing.
const drain = process.env.FLOCKLETTER_PROVE_FULL_CAPTURE;
const fullCapture = drain === 'volume' || drain === 'paced';
const recipientCount = 2500;

it('takes a fresh trial through verified billing, sender setup, certified import and first newsletter capture', async () => {
  const f = await startBillingFixture();
  try {
    const started = performance.now();
    const actor = f.actor();
    const workspace = actor.workspaceId;
    const isOwner = async (user: string, scope: string) => user === actor.userId && scope === workspace;
    const core = new CommandService(f.db);
    const keyed = <T extends object>(input: T) => ({ operationKey: randomUUID(), ...input });
    await core.execute('workspace.initialize', keyed({ name: 'Newsletter trial', brandName: 'Alpine' }), actor);
    const brandId = ((await core.execute('workspace.get', {}, actor)) as Workspace).brands[0]!.id;

    const stripe = simulatedTrialProvider();
    const registry = new TrialRegistry({
      key: randomUUID(), account: stripe.g.account, source: 'stripe_test', historyBaseline: 'verified-empty',
      policy: { id: 'first-newsletter-test', version: 1, mode: 'lifetime', retentionDays: null, approved: true },
    });
    const billing = new CustomerBilling(f.db, {
      environment: 'test', exerciseEnabled: false, gateway: stripe.g, trialRegistry: registry, checkOwner: isOwner,
    });
    await billing.execute('customerBilling.checkout', keyed({ plan: 'starter' }), actor);
    const setup = (await billing.execute('customerBilling.status', {}, actor)) as CustomerBillingStatus;
    const { review } = await billing.execute('customerBilling.trialReview', keyed({ setupId: setup.trialSetup!.id }), actor) as { review: TrialReview };
    await billing.execute('customerBilling.activateTrial', keyed({
      setupId: review.setupId, expectedRevision: review.revision, reviewHash: review.hash, accepted: true,
    }), actor);
    expect((await billing.status(workspace)).eligible).toBe(false);
    await billing.webhook(Buffer.from('evt_' + randomUUID()), 'valid');
    expect(await billing.status(workspace)).toMatchObject({ source: 'stripe', state: 'trialing', eligible: true, limits: { contacts: recipientCount } });
    expect(stripe.trialPosts()).toBe(1);

    const origin = 'https://mail.example.test';
    const delivery = new CustomerDelivery(f.db, {
      mode: 'capture', scope: 'all', environment: 'test', origin, isOwner, billing,
      eligibilitySql: (sql, scope) => customerEligibility(sql, scope, billing.options),
      optOut: createCustomerOptOut, safeguards: new SendingSafeguards(f.db),
      render: async message => {
        if (message.to !== 'reader@campaign.test' || !message.html.includes('Alpine spring news')) {
          throw Error('The private renderer did not receive the saved test message.');
        }
      },
    });
    const domain = 'alpine.example.com';
    await delivery.execute('delivery.saveSender', keyed({
      brandId, fromName: 'Alpine', fromEmail: 'news@' + domain, replyTo: 'shop@' + domain,
      organization: 'Alpine trial', postalAddress: '100 Example Lane, Denver CO 80202',
    }), actor);
    const senders = new ResendSenderSetup(f.db, {
      enabled: true, captured: true, port: capturedSenderSetupPort(), webhookId: randomUUID(),
      isOwner, eligible: (scope, sql) => customerEligibility(sql, scope, billing.options),
    });
    const reviewedSender = (await senders.execute('senderSetup.review', keyed({ brandId, senderRevision: 1 }), actor)) as SenderSetupView;
    const sender = { brandId, setupId: reviewedSender.setup!.id };
    const pending = (await senders.execute('senderSetup.approve', keyed({ ...sender, senderRevision: 1 }), actor)) as SenderSetupView;
    expect(pending.setup).toMatchObject({ state: 'awaiting_dns', dns: [{ name: expect.stringMatching(/\.invalid$/) }] });

    const audience = new CustomerAudience(f.db, {
      mode: 'exercise', origin, checkOwner: isOwner,
      contactLimit: (sql, scope) => customerContactLimit(sql, scope, billing.options),
    });
    await audience.execute('audienceOnboarding.configure', keyed({ brandId, enabled: true, purpose: 'seasonal_news', policyVersion: 'alpine-1',
      consentText: 'Send me Alpine seasonal newsletters. I can unsubscribe at any time.', sourceDomain: domain }), actor);
    const addresses = Array.from({ length: recipientCount }, (_, i) => 'reader-' + i + '@example.test');
    const addressSet = new Set(addresses);
    const csv = Buffer.from(['Email', ...addresses].join('\n')).toString('base64');
    const importRequest = keyed({ brandId, csvBase64: csv, emailColumn: 0, permissionAffirmed: true,
      source: 'Synthetic opt-in list for Alpine seasonal newsletters', confirmWithoutEmail: true, consentPolicyVersion: 'alpine-1' });
    const imported = await audience.execute('audienceOnboarding.import', importRequest, actor) as { id: string; rows: { outcome: string; subscriberId: string }[] };
    expect(imported.rows).toHaveLength(recipientCount);
    expect(imported.rows.every(person => person.outcome === 'subscribed_added')).toBe(true);
    expect(await audience.execute('audienceOnboarding.import', importRequest, actor)).toEqual(imported);

    const campaign = await core.execute('campaign.create', keyed({ brandId, content: { title: 'Spring newsletter', subject: 'Alpine spring news',
      fromName: 'Alpine', replyTo: 'shop@' + domain, heading: 'Alpine spring news', body: 'Welcome to our first seasonal newsletter.',
      preheader: '', ctaLabel: '', ctaUrl: '', assetIds: [] } }), actor) as Campaign;

    // Use the normal DNS recheck interval; pending records, customer data and
    // verification timestamps are never inserted or modified by the test.
    await wait(60_100);
    const verified = await senders.execute('senderSetup.process', keyed(sender), actor) as SenderSetupView;
    expect(verified).toMatchObject({ captured: true, setup: { state: 'verified' } });
    const draft = { brandId, campaignId: campaign.id, expectedVersion: campaign.version };
    const preflight = await delivery.execute('delivery.preflight', draft, actor) as CustomerCampaignPreflight;
    expect(preflight).toMatchObject({ contentReady: true, gaps: [], audience: { selected: recipientCount } });
    const reviewRequest = keyed(draft);
    const letter = await delivery.execute('delivery.review', reviewRequest, actor) as DeliveryView;
    expect(letter).toMatchObject({ state: 'reviewed', version: campaign.version, selected: recipientCount });
    expect(await delivery.execute('delivery.review', reviewRequest, actor)).toEqual(letter);
    const request = keyed({ brandId, id: letter.id });
    const approval = await delivery.execute('delivery.approve', request, actor) as DeliveryView;
    expect(approval.state).toBe('queued');
    expect(await delivery.execute('delivery.approve', request, actor)).toEqual(approval);
    expect(await delivery.execute('delivery.approve', keyed({ brandId, id: letter.id }), actor)).toMatchObject({ id: letter.id, state: 'queued' });

    const queuedAt = performance.now();
    const recipients = await f.db.brand(workspace, brandId, sql => sql.query<{ id: string; email: string; evidence: number }>(
      `SELECT p.subscriber_id id,s.email_normalized email,
        (SELECT count(*)::int FROM subscriber_consent_events e WHERE e.subscriber_id=p.subscriber_id
          AND e.event='confirmed' AND e.source='customer-exercise-owner-attestation' AND e.evidence_source=$2 AND e.recorded_by=$3) evidence
       FROM customer_delivery_recipients p JOIN subscribers s ON (s.workspace_id,s.brand_id,s.id)=(p.workspace_id,p.brand_id,p.subscriber_id)
       WHERE p.delivery_id=$1`, [letter.id, importRequest.source, actor.actorId]));
    expect(recipients.rows).toHaveLength(recipientCount);
    expect(new Set(recipients.rows.map(person => person.email))).toEqual(addressSet);
    expect(new Set(recipients.rows.map(person => person.id))).toEqual(new Set(imported.rows.map(person => person.subscriberId)));
    expect(recipients.rows.every(person => person.evidence === 1)).toBe(true);

    const report = () => delivery.execute('delivery.report', { brandId, id: letter.id }, actor) as Promise<DeliveryView>;
    // A request retried with either its original idempotency key or a new key
    // leaves one frozen delivery, one audience and one active reservation.
    expect((await billing.status(workspace)).usage).toMatchObject({
      emails: 0, reservedEmails: recipientCount, reservedCampaigns: 1, campaigns: 0,
    });
    let worker = delivery.worker;
    async function nextWork() {
      // Rendering and admission are separate worker operations. Pacing may add
      // another pass at the provider's retry time; timed waits never imply acceptance.
      for (let steps = 0; steps < 10; steps++) {
        const tick = await worker.tick(workspace, letter.id);
        if (tick.retryAt) await wait(Math.max(1, Date.parse(tick.retryAt) - Date.now() + 2));
        if (tick.processed) return;
      }
      throw Error('No eligible work reached the first newsletter worker.');
    }
    await nextWork();
    await nextWork();
    expect(await report()).toMatchObject({ mode: 'capture', accepted: 1, delivered: 1, rejected: 0, uncertain: 0 });
    const firstAt = performance.now();
    const count = fullCapture ? recipientCount : 1;
    if (drain === 'volume') {
      worker = new CustomerDelivery(f.db, { ...delivery.options, safeguards: undefined }).worker;
    }
    if (fullCapture) {
      let captured = 1;
      while (captured < count) {
        await nextWork();
        await nextWork();
        const progress = await report();
        if (progress.accepted === captured && progress.state !== 'queued') {
          throw Error('The capture drain stopped in state ' + progress.state);
        }
        captured = progress.accepted;
      }
    }
    const final = await report();
    expect(final).toMatchObject({ accepted: count, delivered: count, rejected: 0, skipped: 0, uncertain: 0 });
    if (fullCapture) expect(final.state).toBe('completed');
    const captures = await f.db.brand(workspace, brandId, sql => sql.query<{ to: string; url: string }>(
      "SELECT payload->>'to' AS to,payload->'unsubscribe'->>'url' url FROM customer_delivery_captures WHERE delivery_id=$1", [letter.id]));
    expect(captures.rows).toHaveLength(count);
    expect(new Set(captures.rows.map(row => row.to)).size).toBe(count);
    expect(captures.rows.every(row => addressSet.has(row.to) && row.url.startsWith(origin + '/newsletter/opt-out?t='))).toBe(true);
    expect((await billing.status(workspace)).usage).toMatchObject({ emails: count, campaigns: 1, reservedEmails: recipientCount - count });
    console.info('First newsletter exercise (seconds)', {
      queued: (queuedAt-started)/1000, firstCapture: (firstAt-started)/1000, total: (performance.now()-started)/1000,
      uniqueQueued: recipients.rows.length, captures: count, drain: drain ?? 'first guarded capture',
    });
  } finally { await f.close(); }
}, drain === 'paced' ? 60 * 60_000 : fullCapture ? 10 * 60_000 : 110_000);
