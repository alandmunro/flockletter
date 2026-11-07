import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { loadConfig, configurationGaps } from './config.js';
import { Database } from './db.js';
import { CommandService } from './service.js';
import { Authenticator, clerkIdentity, localIdentity } from './auth.js';
import { createApp } from './app.js';

if (existsSync('.env')) loadEnvFile('.env');
const config = loadConfig();
let service: CommandService | undefined;
let auth: Authenticator | undefined;
if (configurationGaps(config).length === 0) {
  const db = new Database(config.databaseUrl!);
  await db.verifyBoundary();
  service = new CommandService(db);
  auth = new Authenticator(db, config.localIdentity ? localIdentity() : clerkIdentity(config));
}
const server = createApp(config, service, auth).listen(config.port, config.host, () => {
  console.info(`Flockletter ${config.environment} listening on port ${config.port}. Sending disabled.`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(() => { void service?.db.close().finally(() => process.exit(0)); if (!service) process.exit(0); }); });
