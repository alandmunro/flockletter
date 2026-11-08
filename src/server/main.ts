import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { loadConfig, configurationGaps } from './config.js';
import { Database } from './db.js';
import { CommandService } from './service.js';
import { Authenticator, clerkIdentity, localIdentity } from './auth.js';
import { createApp } from './app.js';
import { loadIntakeBinding, loadLinkBinding } from './subscribers/config.js';
import { SubscriberIntake } from './subscribers/intake.js';
import { DeliveryWorker } from './campaign/delivery-worker.js';
import { deliveryBindings, runDeliveryQueue } from './campaign/delivery-runner.js';
import { CaptureWorker, captureBinding } from './campaign/worker.js';
import { SandboxBilling } from './billing/service.js';
import { sandboxGateway } from './billing/gateway.js';

if (existsSync('.env')) loadEnvFile('.env');
const config = loadConfig();
let service: CommandService | undefined;
let auth: Authenticator | undefined;
const stop = new AbortController();
const tasks: Promise<void>[] = [];
if (configurationGaps(config).length === 0) {
  const db = new Database(config.databaseUrl!);
  await db.verifyBoundary();
  const identity = config.localIdentity ? localIdentity() : clerkIdentity(config);
  const bindings = deliveryBindings(process.env);
  service = new CommandService(
    db,
    new SubscriberIntake(db, loadIntakeBinding(config), loadLinkBinding(config)),
    identity.isOwner,
    undefined,
    new SandboxBilling(db, sandboxGateway(config.origin), process.env.FLOCKLETTER_COMPLIMENTARY_WORKSPACE),
    identity.team,
    (workspace, brand) => bindings.some((b) => b.workspace === workspace && b.brand === brand),
  );
  auth = new Authenticator(db, identity);
  const binding = captureBinding(process.env);
  if (binding) {
    const worker = new CaptureWorker(db, identity.isOwner);
    tasks.push(
      runDeliveryQueue(
        [binding],
        (workspace, brand) => worker.tick(workspace, brand),
        stop.signal,
        () => console.error('Campaign capture worker could not process its queue.'),
      ),
    );
  }
  if (bindings.length) {
    const worker = new DeliveryWorker(db, identity.isOwner);
    tasks.push(runDeliveryQueue(bindings, (workspace, brand) => worker.tick(workspace, brand), stop.signal));
  }
}
const server = createApp(config, service, auth).listen(config.port, config.host, () => {
  console.info(`Flockletter ${config.environment} listening on port ${config.port}. Sending disabled.`);
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    stop.abort();
    server.close(() => {
      void Promise.allSettled(tasks)
        .then(() => service?.db.close())
        .finally(() => process.exit(0));
    });
  });
