import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as pause } from 'node:timers/promises';
import { emptyContent, type Campaign, type CommandName, type Workspace } from '../../src/shared/contracts.js';
import { type Rehearsal, type RecipientOutcome } from '../../src/shared/rehearsal.js';
import { Database } from '../../src/server/db.js';
import { CommandService, type Actor } from '../../src/server/service.js';
import { reviewedListmonkMessage } from '../../src/server/campaign/listmonk-callback.js';
import { isolatedSimulator } from './simulator-proof.js';
import { DeliveryWorker } from '../../src/server/campaign/delivery-worker.js';
import type { DeliveryOutcome, DeliveryProvider } from '../../src/server/campaign/delivery-provider.js';
import { startDatabase } from '../database-fixture.js';
import { recordAccess } from '../complimentary-access.js';
import { studioFixtureImage } from '../studio-fixture-image.js';

const container = process.argv[2] ?? '';
assert(container && /^[a-f0-9]{64}$/.test(container), 'Expected this run’s isolated Docker helper');
const fixture = await startDatabase();
const runtime = new Database(fixture.url),
  admin = new Database(fixture.adminUrl);
const service = new CommandService(runtime, undefined, async () => true);
const workspace = 'org_listmonk_worker_fixture';
const owner: Actor = {
  kind: 'session',
  workspaceId: workspace,
  actorId: 'user:fixture',
  userId: 'fixture',
  scopes: ['read'],
  owner: true,
  brandIds: null,
};
const command = <T>(name: CommandName, input: unknown) => service.execute(name, input, owner) as Promise<T>;
const keyed = <T extends object>(input: T) => ({ ...input, operationKey: randomUUID() });

async function prove() {
  await runtime.verifyBoundary();
  await command('workspace.initialize', keyed({ name: 'Worker fixture', brandName: 'Trailhead' }));
  const brandId = (await command<Workspace>('workspace.get', {})).brands[0]!.id;
  await recordAccess(admin, workspace, {
    workspaceId: workspace,
    plan: 'starter',
    operator: 'fixture',
    reason: 'Isolated Listmonk worker verification',
    operationKey: randomUUID(),
  });
  const photo = await studioFixtureImage('#8b4764');
  const digest = createHash('sha256').update(photo).digest('hex');
  const upload = await command<{ results: { asset: { id: string } }[] }>(
    'asset.uploadBatch',
    keyed({
      brandId,
      files: [{ itemKey: randomUUID(), name: 'Trailhead.png', base64: photo.toString('base64') }],
    }),
  );
  const content = {
    ...emptyContent(),
    title: 'Worker fixture',
    subject: 'Field notes {{ .Subscriber.Email }}',
    fromName: 'Trailhead',
    replyTo: 'sender@example.test',
    heading: 'Trailhead',
    body: 'A literal {{ .Subscriber.Email }} stays in this message.',
    assetIds: [upload.results[0]!.asset.id],
  };
  const draft = await command<Campaign>('campaign.create', keyed({ brandId, content }));
  const withdrawn = randomUUID();
  const simulator = isolatedSimulator(workspace, brandId);
  await runtime.brand(workspace, brandId, (sql) =>
    sql.query(
      "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'reader@campaign.test','confirmed'),($1,$2,$4,'pending@example.test','confirmed')",
      [workspace, brandId, randomUUID(), withdrawn],
    ),
  );
  const review = await command<Rehearsal>(
    'rehearsal.review',
    keyed({
      brandId,
      campaignId: draft.id,
      expectedVersion: draft.version,
      audience: 'confirmed',
      transport: 'provider_test',
      dueAt: new Date(Date.now() + 60000).toISOString(),
    }),
  );
  assert.equal(review.selected, 2);
  const run = { brandId, id: review.id };
  await command('rehearsal.approve', keyed(run));
  await command('audience.unsubscribe', { brandId, id: withdrawn });

  // Only stdin/stdout cross the machine boundary. Listmonk, its messenger and its database
  // stay on the private Docker network. The Flockletter worker uses its normal runtime role.
  const peer = spawn(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'FIXTURE_WORKSPACE=' + workspace,
      '-e',
      'FIXTURE_BRAND=' + brandId,
      container,
      'node',
      '--experimental-strip-types',
      '/fixture/worker-peer.mjs',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    peer.once('exit', resolve);
    peer.once('error', reject);
  });
  const replies = createInterface({ input: peer.stdout })[Symbol.asyncIterator]();
  async function read<T>() {
    const line = await replies.next();
    assert(!line.done, 'Isolated Listmonk peer ended before replying');
    return JSON.parse(line.value) as T;
  }
  const call = <T>(value: unknown) => {
    peer.stdin.write(JSON.stringify(value) + '\n');
    return read<T>();
  };
  try {
    assert.deepEqual(await read(), { ready: true });
    const provider: DeliveryProvider = {
      async submit(message) {
        assert.equal(message.to, 'reader@campaign.test');
        assert.equal(message.subject, content.subject);
        assert(message.html.includes('cid:' + digest) && message.text.includes(content.body));
        assert.deepEqual(
          message.images.map((image) => image.bytes),
          [photo],
        );
        // A Listmonk HTTP response alone is never the provider receipt.
        assert.equal(
          await call<DeliveryOutcome>({
            action: 'submit',
            message: {
              ...message,
              images: message.images.map((image) => ({ ...image, bytes: image.bytes.toString('base64') })),
            },
          }),
          'unknown',
        );
        let callback: unknown = null;
        const deadline = Date.now() + 5000;
        while (!callback && Date.now() < deadline) {
          callback = await call({ action: 'callback', operationKey: message.operationKey });
          if (!callback) await pause(50);
        }
        assert(callback, 'Listmonk did not produce an authenticated messenger callback');
        // Still inside the guarded worker submission. Lookup does not create a downstream send.
        const reviewed = reviewedListmonkMessage(callback, message);
        assert.equal(await simulator.provider.submit(reviewed), 'accepted');
        simulator.verify(message);
        assert.equal(
          await call({
            action: 'acknowledge',
            operationKey: message.operationKey,
            providerId: simulator.receipt(message.operationKey),
          }),
          true,
        );
        return 'unknown'; // Drop the worker-facing acknowledgement after provider acceptance.
      },
      lookup: (operationKey) => call<DeliveryOutcome>({ action: 'lookup', operationKey }),
    };
    const tick = () =>
      new DeliveryWorker(runtime, async () => true, provider).tick(workspace, brandId, review.id);
    const report = () => command<Rehearsal>('rehearsal.report', run);
    await tick();
    assert.equal((await report()).pending, 2, 'No recipient may be released before the scheduled time');
    // Advance only the test clock fields, scoped to this fixture's disposable database.
    await runtime.brand(workspace, brandId, (sql) =>
      sql.query('UPDATE campaign_rehearsals SET due_at=now() WHERE id=$1', [review.id]),
    );
    for (let i = 0; i < 3 && !(await report()).uncertain; i++) await tick();
    assert.equal((await report()).uncertain, 1, 'A lost engine acknowledgment needs reconciliation');
    const deadline = Date.now() + 15000;
    while ((await report()).state === 'queued' && Date.now() < deadline) {
      await runtime.brand(workspace, brandId, (sql) =>
        sql.query(
          "UPDATE rehearsal_recipients SET next_check_at=now() WHERE rehearsal_id=$1 AND state='uncertain'",
          [review.id],
        ),
      );
      await tick();
      await pause(100);
    }
    const finished = await report();
    assert.equal(finished.state, 'completed');
    assert.equal(finished.accepted, 1);
    assert.equal(finished.skipped, 1);
    const { recipients } = await command<{ recipients: RecipientOutcome[] }>('rehearsal.outcomes', run);
    assert.deepEqual(recipients.map((item) => item.state).sort(), ['accepted', 'excluded']);
    assert.equal(recipients.find((item) => item.state === 'excluded')!.attempts, 0);
    await tick();
    assert.deepEqual(await call({ action: 'stats' }), {
      submissions: 1,
      acceptedCalls: ['reader@campaign.test'],
    });
    assert.equal(simulator.count(), 1);
    console.log(
      'Flockletter scheduled two recipients, excluded the later opt-out and reconciled exactly one Listmonk → SES SDK submission with both reviewed bodies and original inline photos.',
    );
  } finally {
    simulator.close();
    peer.stdin.end();
    assert.equal(await exited, 0, 'Isolated Listmonk peer failed');
  }
}
try {
  await prove();
} finally {
  await admin.close();
  await runtime.close();
  await fixture.stop();
}
