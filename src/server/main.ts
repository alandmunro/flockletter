import {externalDelivery} from '../shared/customer-delivery.js';
import { loadMarketingLinks } from './subscribers/marketing-links.js';
import {startLegacyMessenger} from './private-engine-startup.js';
import {loadSesRuntime} from './campaign/ses-runtime.js';
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
import { platformRuntime } from './platform/runtime.js';
import type { PlatformService } from './platform/service.js';
import { CustomerWorkflows } from './customer-runtime.js';
import { requestStagingWebhookTest } from './workspace-gifts/staging-webhook-test.js';

if (existsSync('.env')) loadEnvFile('.env');
const config = loadConfig();
const marketing = loadMarketingLinks(config.origin);
const ses=loadSesRuntime(process.env);
let service: CommandService | undefined;
let messenger:Awaited<ReturnType<typeof startLegacyMessenger>>;
let auth: Authenticator | undefined;
let platform:PlatformService|undefined;
const stop = new AbortController();
const tasks: Promise<void>[] = [];
if (configurationGaps(config).length === 0) {
  const db = new Database(config.databaseUrl!,config.databasePoolMax);
  await db.verifyBoundary();
  if((await db.pool.query('SELECT public.flockletter_restore_blocked() blocked')).rows[0]?.blocked)throw Error('Restored data remains quarantined. Complete protected checkpoint reconciliation and operator release before startup.');
  const identity = config.localIdentity ? localIdentity() : clerkIdentity(config);
  const customer=await CustomerWorkflows.start(db,config,identity);
  await customer.engine?.verify();
  const bindings = deliveryBindings(process.env);
  messenger=await startLegacyMessenger(config,db,identity.isOwner,ses,process.env,marketing);
  service = new CommandService(
    db,
    new SubscriberIntake(db, loadIntakeBinding(config), loadLinkBinding(config)),
    identity.isOwner,
    undefined,
    new SandboxBilling(db, sandboxGateway(config.origin), process.env.FLOCKLETTER_COMPLIMENTARY_WORKSPACE),
    identity.team,
    (workspace, brand) => bindings.some((b) => b.workspace === workspace && b.brand === brand),
    ses,
    messenger?.dispatcher,
    config.environment, marketing,customer,
  );
  auth = new Authenticator(db, identity,customer.billing.options);
  platform=await platformRuntime(config,db,auth,customer);
  if(!customer.settings.dedicated)tasks.push(customer.run(stop.signal));
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
    const worker = new DeliveryWorker(db, identity.isOwner, undefined, ses, messenger?.dispatcher, marketing);
    tasks.push(runDeliveryQueue(bindings, (workspace, brand) => worker.tick(workspace, brand), stop.signal));
  }
}
const server = createApp(config, service, auth, platform).listen(config.port, config.host, () => {
  if (config.environment === 'staging' && service && process.env.FLOCKLETTER_GIFT_WEBHOOK_TEST_ID) {
    tasks.push(requestStagingWebhookTest(service.db, process.env).catch(() => {
      console.error('Tremendous staging webhook test could not verify or contact its configured destination.');
    }));
  }
  console.info(`Flockletter ${config.environment} listening on port ${config.port}. Customer delivery ${externalDelivery(service?.customer?.settings.delivery??'off')?'requires verified per-brand provider eligibility':'disabled'}.`);
});
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => {
    console.error('Forced exit after shutdown timeout.');
    process.exit(1);
  }, 15_000);
  forceExit.unref();
  stop.abort();
  const httpClosed = new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
  void httpClosed
    .then(() => Promise.allSettled(tasks))
    .then(() => service?.customer?.close())
    .then(() => { ses?.close?.(); })
    .then(() => messenger?.close())
    .then(() => platform?.close())
    .then(() => service?.db.close())
    .finally(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
};
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);
