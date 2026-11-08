import { createPrivateKey, randomUUID, sign, type KeyObject, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeSesEvent, SesFeedbackRouter, SesNotifications } from '../src/server/campaign/ses-notifications.js';
import { parseSesRoute, type SesRoute } from '../src/server/campaign/ses-runtime.js';
import { PrivateListmonk } from '../src/server/campaign/private-listmonk.js';
import { CommandService } from '../src/server/service.js';
import { emptyContent, type Campaign } from '../src/shared/contracts.js';
import type { RecipientOutcome, Rehearsal } from '../src/shared/rehearsal.js';
import { startDeliveryFixture } from './staging-delivery-fixture.js';

const accountId = '123456789012';
const region = 'us-west-2';
const snsOrigin = 'https://sns.' + region + '.amazonaws.com';
const signingCertURL = snsOrigin + '/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem';
const domain = 'shop.example.org';
const sender = 'newsletter@' + domain;
const simulator = 'success@simulator.amazonses.com';
function makeRoute(workspaceId = 'org_notifications', brandId: string = randomUUID()) {
  return parseSesRoute({
    workspaceId,
    brandId,
    region,
    accountId,
    from: sender,
    tenant: 'test-tenant',
    configurationSet: 'feedback-set',
    identityArn: 'arn:aws:ses:' + region + ':' + accountId + ':identity/' + domain,
    topicArn: 'arn:aws:sns:' + region + ':' + accountId + ':flockletter-test',
  });
}

async function ephemeralSigner() {
  const directory = await mkdtemp(join(tmpdir(), 'flockletter-test-sns-'));
  try {
    const key = join(directory, 'private.pem'),
      cert = join(directory, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-new',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=synthetic-sns-test',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    return {
      key: createPrivateKey(await readFile(key)),
      certificate: new X509Certificate(await readFile(cert)),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
let site: Awaited<ReturnType<typeof startDeliveryFixture>>;
let signer: { key: KeyObject; certificate: X509Certificate };
const route = makeRoute();
const body = (message: Record<string, string>) => Buffer.from(JSON.stringify(message), 'utf8');
// SNS signs the required fields in byte order, each name and value followed by LF.
// The fixture signs its own raw values independently of the receiver's implementation.
function signed(fields: Record<string, string>, version = '2') {
  const text =
    Object.keys(fields)
      .sort()
      .map((key) => [key, fields[key]])
      .flat()
      .join('\n') + '\n';
  return {
    ...fields,
    SignatureVersion: version,
    SigningCertURL: signingCertURL,
    Signature: sign(
      version === '1' ? 'RSA-SHA1' : 'RSA-SHA256',
      Buffer.from(text, 'utf8'),
      signer.key,
    ).toString('base64'),
  };
}
function notification(route: SesRoute, event: unknown, extra: Record<string, string> = {}) {
  return {
    Type: 'Notification',
    MessageId: randomUUID(),
    Timestamp: new Date().toISOString(),
    TopicArn: route.topicArn,
    Message: JSON.stringify(event),
    ...extra,
  };
}
function confirmation(route: SesRoute, token = 'fixture-confirmation') {
  const url = new URL('/', snsOrigin);
  url.search = new URLSearchParams({
    Action: 'ConfirmSubscription',
    TopicArn: route.topicArn,
    Token: token,
  }).toString();
  return {
    Type: 'SubscriptionConfirmation',
    MessageId: randomUUID(),
    Timestamp: new Date().toISOString(),
    TopicArn: route.topicArn,
    Message: 'Confirm this test subscription.',
    Token: token,
    SubscribeURL: url.href,
  };
}
function delivery(route: SesRoute, operation: string, destination = simulator) {
  return {
    eventType: 'Delivery',
    mail: {
      messageId: 'ses-fixture-' + operation,
      sendingAccountId: route.accountId,
      source: route.from,
      sourceArn: route.identityArn,
      destination: [destination],
      tags: {
        fl_operation: [operation],
        fl_tenant: [route.tenant],
        'ses:configuration-set': [route.configurationSet],
      },
    },
    delivery: { recipients: [destination] },
  };
}

beforeAll(async () => {
  signer = await ephemeralSigner();
  site = await startDeliveryFixture();
});
afterAll(async () => {
  await site?.close();
});

describe('signed SES simulator notifications', () => {
  it('requires a current provisioning authorization before confirming a customer topic',async()=>{
    const confirm=vi.fn(async()=>{});
    const handler=new SesNotifications(route,async()=>signer.certificate,confirm,
      {customer:true,canConfirm:async()=>false,apply:async()=>{}});
    await expect(handler.handle(site.db,body(signed(confirmation(route))))).rejects.toMatchObject({code:'invalid_provider_event'});
    expect(confirm).not.toHaveBeenCalled();
  });
  it('keeps current and previously reviewed sender profiles on one trusted topic',async()=>{
    const old=makeRoute('org_history');
    const current=parseSesRoute({workspaceId:old.workspaceId,brandId:old.brandId,region:old.region,accountId:old.accountId,
      from:'updated@'+domain,tenant:old.tenant,configurationSet:old.configurationSet,identityArn:old.identityArn,topicArn:old.topicArn});
    const older=vi.fn(async()=>{}),newer=vi.fn(async()=>{});
    const router=new SesFeedbackRouter([new SesNotifications(old,async()=>signer.certificate,undefined,{customer:true,apply:older})]);
    router.register(new SesNotifications(current,async()=>signer.certificate,undefined,{customer:true,apply:newer}));
    const event=delivery(current,randomUUID(),'reader@store.example');
    const customer={...event,mail:{...event.mail,tags:{...event.mail.tags,fl_customer:['1'],fl_brand:[current.brandId]}}};
    await router.handle(site.db,body(signed(notification(current,customer))));
    expect(newer).toHaveBeenCalledOnce();expect(older).not.toHaveBeenCalled();
    const legacy={...customer,mail:{...customer.mail,source:old.from}};
    await router.handle(site.db,body(signed(notification(old,legacy))));
    expect(older).toHaveBeenCalledOnce();
  });
  it('routes only a configured topic and rechecks its signature after selecting the brand', async () => {
    const other = {...makeRoute('org_other'),topicArn:route.topicArn+'-other'};
    const first=vi.fn(async () => signer.certificate), second=vi.fn(async () => signer.certificate);
    const router=new SesFeedbackRouter([new SesNotifications(route,first),new SesNotifications(other,second)]);
    const payload=signed(notification(other,{eventType:'Send'}));
    await router.handle(site.db,body(payload));
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledOnce();
    await expect(router.handle(site.db,body({...payload,TopicArn:route.topicArn}))).rejects.toMatchObject({code:'invalid_provider_event'});
    await expect(router.handle(site.db,body({...payload,TopicArn:route.topicArn+'-unknown'}))).rejects.toMatchObject({code:'invalid_provider_event'});
    expect(first).toHaveBeenCalledOnce();
  });
  it('verifies the signature with an optional subject and rejects changed payloads, wrong topics, SHA-1 and future timestamps', async () => {
    const load = vi.fn(async () => signer.certificate);
    const handler = new SesNotifications(route, load);
    const fields = notification(
      route,
      { eventType: 'Send', example: 'Line one\nLine two' },
      { Subject: 'Forecast for Après\nSaturday' },
    );
    const genuine = signed(fields);
    await handler.handle(site.db, body(genuine));
    expect(load).toHaveBeenCalledWith(signingCertURL);
    const rejected = [
      { ...genuine, Message: JSON.stringify({ eventType: 'Send' }) },
      { ...genuine, Subject: 'Changed subject' },
      signed({ ...fields, TopicArn: route.topicArn + '-other' }),
      signed({ ...fields, Timestamp: new Date(Date.now() + 3600000).toISOString() }),
      signed(fields, '1'),
    ];
    for (const notification of rejected)
      await expect(handler.handle(site.db, body(notification))).rejects.toMatchObject({
        code: 'invalid_provider_event',
      });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('fetches certificates only at the exact regional AWS path and refuses redirects', async () => {
    const load = vi.fn(async () => signer.certificate);
    const handler = new SesNotifications(route, load);
    const genuine = signed(notification(route, { eventType: 'Send' }));
    for (const unsafe of [
      signingCertURL.replace('https:', 'http:'),
      signingCertURL.replace('amazonaws.com', 'amazonaws.com.example.org'),
      signingCertURL.replace('https://', 'https://fixture@'),
      signingCertURL + '?x=1',
      signingCertURL + '#extra',
      snsOrigin + '/unrelated.pem',
    ])
      await expect(
        handler.handle(site.db, body({ ...genuine, SigningCertURL: unsafe })),
      ).rejects.toMatchObject({ code: 'invalid_provider_event' });
    expect(load).not.toHaveBeenCalled();
    const transfer = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(null, { status: 307, headers: { Location: 'https://unknown.example.org/signing.pem' } }),
      );
    try {
      await expect(new SesNotifications(route).handle(site.db, body(genuine))).rejects.toMatchObject({
        code: 'certificate_unavailable',
      });
      expect(transfer).toHaveBeenCalledTimes(1);
      expect(transfer).toHaveBeenCalledWith(signingCertURL, expect.objectContaining({ redirect: 'error' }));
    } finally {
      transfer.mockRestore();
    }
  });

  it('confirms only the signed regional topic and token, with redirect following disabled', async () => {
    const confirm = vi.fn(async () => {});
    const handler = new SesNotifications(route, async () => signer.certificate, confirm);
    const fields = confirmation(route);
    await handler.handle(site.db, body(signed(fields)));
    expect(confirm).toHaveBeenCalledExactlyOnceWith(fields.SubscribeURL);
    const unsafe = [
      fields.SubscribeURL.replace('amazonaws.com', 'unrelated.example.org'),
      fields.SubscribeURL.replace('fixture-confirmation', 'other-token'),
      fields.SubscribeURL.replace('flockletter-test', 'other-topic'),
      fields.SubscribeURL + '&Token=fixture-confirmation',
      fields.SubscribeURL + '&extra=1',
      fields.SubscribeURL + '#fragment',
    ];
    for (const url of unsafe)
      await expect(
        handler.handle(site.db, body(signed({ ...fields, SubscribeURL: url }))),
      ).rejects.toMatchObject({ code: 'invalid_provider_event' });
    expect(confirm).toHaveBeenCalledTimes(1);
    const transfer = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://unknown.example.org/confirm' } }),
      );
    try {
      await expect(
        new SesNotifications(route, async () => signer.certificate).handle(site.db, body(signed(fields))),
      ).rejects.toMatchObject({ code: 'confirmation_unavailable' });
      expect(transfer).toHaveBeenCalledTimes(1);
      expect(transfer).toHaveBeenCalledWith(
        fields.SubscribeURL,
        expect.objectContaining({ redirect: 'error' }),
      );
    } finally {
      transfer.mockRestore();
    }
  });

  it('requires the sending account, identity, configuration, tenant and exact simulator recipient for every event', () => {
    const operation = randomUUID(),
      event = delivery(route, operation),
      mail = event.mail;
    expect(decodeSesEvent(route, event)).toMatchObject({
      operation,
      kind: 'delivered',
      destination: simulator,
    });
    const wrongMail = [
      { ...mail, sendingAccountId: '000000000000' },
      { ...mail, source: 'alternate@' + domain },
      { ...mail, sourceArn: route.identityArn + '/extra' },
      { ...mail, tags: { ...mail.tags, fl_tenant: ['other-tenant'] } },
      { ...mail, tags: { ...mail.tags, fl_tenant: [route.tenant, route.tenant] } },
      { ...mail, tags: { ...mail.tags, 'ses:configuration-set': ['other-set'] } },
      { ...mail, tags: { ...mail.tags, fl_operation: ['invalid-operation'] } },
      { ...mail, destination: ['user@example.org'] },
    ];
    for (const wrong of wrongMail) expect(() => decodeSesEvent(route, { ...event, mail: wrong })).toThrow();
    expect(() =>
      decodeSesEvent(route, { ...event, delivery: { recipients: ['complaint@simulator.amazonses.com'] } }),
    ).toThrow();
    for (const [bounceType, kind] of [
      ['Transient', 'temporary_bounce'],
      ['Undetermined', 'temporary_bounce'],
      ['Permanent', 'permanent_bounce'],
    ]) {
      expect(
        decodeSesEvent(route, {
          eventType: 'Bounce',
          mail,
          bounce: { bounceType, bouncedRecipients: [{ emailAddress: simulator }] },
        }),
      ).toMatchObject({ operation, kind });
    }
    expect(() =>
      decodeSesEvent(route, {
        eventType: 'Bounce',
        mail,
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'user@example.org' }] },
      }),
    ).toThrow();
  });

  it.each(['ses_simulator', 'listmonk_ses'] as const)(
    'reconciles a lost %s acknowledgment by signed notification without another submission',
    async (method) => {
      const workspace = await site.workspace();
      try {
        const route = makeRoute(workspace.workspaceId, workspace.brandId);
        const send = vi.fn(async () => {
          throw Error('Connection timed out after provider acceptance.');
        });
        const ses = { route, port: { send } };
        const engine = new PrivateListmonk(
          site.db,
          site.identity.isOwner,
          { workspace: route.workspaceId, brand: route.brandId },
          {
            async render(message, reference) {
              await engine.receive({
                from_email: reference,
                subject: message.subject,
                body: message.html,
                content_type: 'html',
                recipients: [{ email: message.to }],
                attachments: [],
              });
            },
          },
          ses,
        );
        const service = new CommandService(
          site.db,
          undefined,
          site.identity.isOwner,
          undefined,
          undefined,
          undefined,
          (workspaceId, brandId) => workspaceId === route.workspaceId && brandId === route.brandId,
          ses,
          engine,
        );
        await site.db.brand(route.workspaceId, route.brandId, (sql) =>
          sql.query(
            'INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,checked_at,verified_at) VALUES($1,$2,$3,$4,now(),now())',
            [route.workspaceId, route.brandId, domain, randomUUID()],
          ),
        );
        const draft = await workspace.command<Campaign>('campaign.create', {
          brandId: route.brandId,
          operationKey: randomUUID(),
          content: {
            ...emptyContent(),
            title: 'Signed SES test',
            subject: 'A clear weekend',
            fromName: 'Trail shop',
            replyTo: 'info@example.test',
            heading: 'Weekend forecast',
            body: 'The trail is ready.',
          },
        });
        const item = (await service.execute(
          'rehearsal.review',
          {
            brandId: route.brandId,
            campaignId: draft.id,
            expectedVersion: draft.version,
            audience: 'test',
            transport: method,
            operationKey: randomUUID(),
          },
          workspace.owner,
        )) as Rehearsal;
        const args = { brandId: route.brandId, id: item.id };
        await service.execute('rehearsal.approve', { ...args, operationKey: randomUUID() }, workspace.owner);
        const step = () =>
          service.execute('rehearsal.process', { ...args, operationKey: randomUUID() }, workspace.owner);
        await step();
        await step();
        const held = await workspace.command<{ recipients: RecipientOutcome[] }>('rehearsal.outcomes', args);
        expect(held.recipients).toMatchObject([{ state: 'uncertain', attempts: 1 }]);
        const operation = held.recipients[0]!.id;
        expect(send).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            Destination: { ToAddresses: [simulator] },
            EmailTags: expect.arrayContaining([{ Name: 'fl_operation', Value: operation }]),
          }),
        );
        const handler = new SesNotifications(route, async () => signer.certificate);
        const event = delivery(route, operation);
        const wrong = { ...event, mail: { ...event.mail, sendingAccountId: '000000000000' } };
        await expect(handler.handle(site.db, body(signed(notification(route, wrong))))).rejects.toMatchObject(
          {
            code: 'feedback_unmapped',
          },
        );
        expect(await workspace.command('rehearsal.report', args)).toMatchObject({
          accepted: 0,
          uncertain: 1,
        });
        const notificationBytes = body(signed(notification(route, event)));
        await handler.handle(site.db, notificationBytes);
        await handler.handle(site.db, notificationBytes);
        await step();
        expect(send).toHaveBeenCalledTimes(1);
        expect(await workspace.command('rehearsal.report', args)).toMatchObject({
          state: 'completed',
          accepted: 1,
          uncertain: 0,
        });
        expect(await workspace.tool('rehearsal_outcomes', args)).toMatchObject({
          recipients: [{ id: operation, state: 'accepted', feedback: 'delivered', attempts: 1 }],
        });
        const events = await site.db.brand(route.workspaceId, route.brandId, (sql) =>
          sql.query('SELECT event_id FROM campaign_provider_events WHERE operation_key=$1', [operation]),
        );
        expect(events.rowCount).toBe(1);
      } finally {
        await workspace.close();
      }
    },
  );
});
