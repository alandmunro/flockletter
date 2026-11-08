import {loadSesRuntime} from './ses-runtime.js';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { configurationGaps, loadConfig } from '../config.js';
import { Database } from '../db.js';
import { clerkIdentity, localIdentity } from '../auth.js';
import { deliveryBindings, runDeliveryQueue } from './delivery-runner.js';
import { DeliveryWorker } from './delivery-worker.js';

if (existsSync('.env')) loadEnvFile('.env');
const config = loadConfig();
const ses=loadSesRuntime(process.env);
const bindings = deliveryBindings(process.env);
if (!bindings.length || configurationGaps(config).length)
  throw new Error('Configure the dedicated Flockletter database, identity and synthetic delivery bindings.');
const db = new Database(config.databaseUrl!);
const identity = config.localIdentity ? localIdentity() : clerkIdentity(config);
const worker = new DeliveryWorker(db, identity.isOwner, undefined, ses);
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
try {
  await db.verifyBoundary();
  await runDeliveryQueue(bindings, (w, b) => worker.tick(w, b), stop.signal);
} finally {
  ses?.close?.();
  await db.close();
}
