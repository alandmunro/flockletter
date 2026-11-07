import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { loadConfig, configurationGaps } from './config.js';
import { Database } from './db.js';
import { CommandService } from './service.js';
import { Authenticator, clerkIdentity, localIdentity } from './auth.js';
import { createApp } from './app.js';
import { loadIntakeBinding, loadLinkBinding } from './subscribers/config.js';
import { SubscriberIntake } from './subscribers/intake.js';
import { CaptureWorker, captureBinding } from './campaign/worker.js';
import { SandboxBilling } from './billing/service.js';
import { sandboxGateway } from './billing/gateway.js';

if (existsSync('.env')) loadEnvFile('.env');
const config = loadConfig();
let service: CommandService | undefined;
let auth: Authenticator | undefined;
let captureTimer: ReturnType<typeof setInterval> | undefined;
if (configurationGaps(config).length === 0) {
  const db = new Database(config.databaseUrl!);
  await db.verifyBoundary();
  const identity=config.localIdentity ? localIdentity() : clerkIdentity(config);
  service = new CommandService(db, new SubscriberIntake(db, loadIntakeBinding(config), loadLinkBinding(config)),identity.isOwner,undefined,
    new SandboxBilling(db,sandboxGateway(config.origin),process.env.FLOCKLETTER_COMPLIMENTARY_WORKSPACE));
  auth = new Authenticator(db, identity);
  const binding=captureBinding(process.env);
  if(binding) {
    const worker=new CaptureWorker(db,identity.isOwner);
    let running=false;
    const tick=async()=>{ if(running)return; running=true;
      try {await worker.tick(binding.workspace,binding.brand);} catch { console.error('Campaign capture worker could not process its queue.'); }
      finally{running=false;} };
    captureTimer=setInterval(()=>void tick(),15000);
    void tick();
  }
}
const server = createApp(config, service, auth).listen(config.port, config.host, () => {
  console.info(`Flockletter ${config.environment} listening on port ${config.port}. Sending disabled.`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { clearInterval(captureTimer); server.close(() => { void service?.db.close().finally(() => process.exit(0)); if (!service) process.exit(0); }); });
