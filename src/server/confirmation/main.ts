import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { setTimeout as pause } from 'node:timers/promises';
import { loadConfig } from '../config.js';
import { Database } from '../db.js';
import { clerkIdentity, localIdentity } from '../auth.js';
import { loadIntakeBinding } from '../subscribers/config.js';
import { configuredProvider } from './provider.js';
import { ConfirmationWorker } from './worker.js';

if (existsSync('.env')) loadEnvFile('.env');
const config = loadConfig();
const binding = loadIntakeBinding(config);
if (!binding || !config.databaseUrl)
  throw new Error('The Flockletter confirmation worker needs an explicit staging binding and database.');
const db = new Database(config.databaseUrl);
if (!config.localIdentity && (!config.clerkSecretKey || !config.clerkPublishableKey))
  throw new Error('A hosted confirmation worker requires the Flockletter Clerk instance.');
const identity = config.localIdentity ? localIdentity() : clerkIdentity(config);
const worker = new ConfirmationWorker(
  db,
  binding,
  configuredProvider(binding, process.env),
  identity.isOwner,
);
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
try {
  await db.verifyBoundary();
  while (!stop.signal.aborted) {
    try {
      const busy = await worker.tick();
      const alerts = await worker.alerts();
      if (alerts.backlog || alerts.unresolved || alerts.provider_errors)
        console.warn('Confirmation worker alert', alerts);
      if (busy) continue;
    } catch {
      console.error('Confirmation worker could not complete its database operation.');
    }
    await pause(15000, undefined, { signal: stop.signal }).catch(() => {});
  }
} finally {
  await db.close();
}
