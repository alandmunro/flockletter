import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { Authenticator, localIdentity } from '../src/server/auth.js';
import { createApp } from '../src/server/app.js';
import { loadConfig, type Config } from '../src/server/config.js';
import { platformRuntime } from '../src/server/platform/runtime.js';
import type { PlatformService } from '../src/server/platform/service.js';
import { CustomerWorkflows } from '../src/server/customer-runtime.js';
import { randomUUID } from 'node:crypto';
import {AppError} from '../src/server/errors.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>;
let db: Database;
let config: Config;
let identity: ReturnType<typeof localIdentity>;
let service: CommandService;
let auth: Authenticator;
let customer: CustomerWorkflows;
let platform: PlatformService | undefined;
let server: Server;
let origin: string;
let noPlatformServer: Server | undefined;

const ownerActor: Actor = {
  workspaceId: 'org_local_sample',
  userId: 'local_owner',
  actorId: 'user:local_owner',
  owner: true,
  kind: 'session',
  scopes: ['read', 'draft:write', 'assets:write'],
  brandIds: null,
};

const ownerHeaders = { authorization: 'Bearer local-development-only', 'content-type': 'application/json' };

async function post(path: string, body: unknown, headers: Record<string,string> = ownerHeaders) {
  return fetch(`${origin}${path}`, { method: 'POST', headers: {...ownerHeaders,...headers}, body: JSON.stringify(body) });
}

async function get(path: string, headers: Record<string,string> = ownerHeaders) {
  return fetch(`${origin}${path}`, { method: 'GET', headers: {...ownerHeaders,...headers} });
}

beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  identity = localIdentity();

  config = loadConfig({
    APP_ENV: 'test',
    LOCAL_TEST_IDENTITY: 'true',
    DATABASE_URL: fixture.url,
    APP_ORIGIN: 'http://127.0.0.1:4310',
  });

  service = new CommandService(db, undefined, identity.isOwner);
  auth = new Authenticator(db, identity);

  await service.execute('workspace.initialize', { operationKey: randomUUID(), name: 'Local sample workspace', brandName: 'Sample retail' }, ownerActor);

  customer = new CustomerWorkflows(db, config, identity, { FLOCKLETTER_CUSTOMER_SUPPORT: 'capture' });

  const platformEnv = { FLOCKLETTER_PLATFORM_MODE: 'capture' };
  platform = await platformRuntime(config, db, auth, customer, platformEnv);

  const app = createApp(config, service, auth, platform as PlatformService | undefined);
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  const secondary=noPlatformServer;
  if (secondary) await new Promise<void>(resolve => secondary.close(() => resolve()));
  await platform?.close();
  await db?.close();
  await fixture?.stop();
});

describe('Platform HTTP authority and exercise boundary', () => {
  it.each([
    ['operator_first_factor_required','first_factor'],
    ['operator_mfa_required','multi_factor'],
  ])('returns the canonical %s reverification level without running a command',async(code,level)=>{
    const original=platform!.options.identity;
    platform!.options.identity={authenticate:async()=>{throw new AppError(403,code,'Synthetic verification required.');},current:async()=>false};
    try {
      const response=await post('/api/operator/v1/commands/platform.overview',{});
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({clerk_error:{type:'forbidden',reason:'reverification-error',metadata:{reverification:{level,afterMinutes:5}}}});
    }finally{platform!.options.identity=original;}
  });
  it('accepts customer connection identity but rejects operator commands for that token', async () => {
    const created = await service.execute('connection.create', { operationKey: randomUUID(), name: 'Customer API', scopes: ['read'], brandIds: [(await service.execute('workspace.get',{},ownerActor) as {brands:{id:string}[]}).brands[0]!.id], expiresInDays: 30 }, ownerActor) as { token: string; connection: { id: string } };

    const identityResponse = await get('/api/v1/connection/identity', { authorization: `Bearer ${created.token}` });
    expect(identityResponse.status).toBe(200);

    const operatorResponse = await post('/api/operator/v1/commands/platform.overview', {}, { authorization: `Bearer ${created.token}` });
    expect(operatorResponse.status).toBe(403);
    const body = await operatorResponse.json();
    expect(body.error.code).toBe('operator_required');

    await service.execute('connection.revoke', { operationKey: randomUUID(), id: created.connection.id }, ownerActor);
  });

  it('returns overview and opens support case for the local owner', async () => {
    const overview = await post('/api/operator/v1/commands/platform.overview', {});
    expect(overview.status).toBe(200);

    const ticket = await customer.support.execute('support.create', {operationKey:randomUUID(),subject:'Plan question',text:'What does each plan include?',topic:'plans'},ownerActor) as {id:string};

    const opened = await post('/api/operator/v1/commands/platform.openCase', { operationKey: randomUUID(), workspaceId: 'org_local_sample', kind: 'support', resourceId: ticket.id, reason: 'Review the exact bounded customer issue.' });
    expect(opened.status).toBe(200);
  });

  it('rejects foreign browser origin before creating an open case', async () => {
    const before = await db.tenant('org_local_sample', async sql => (await sql.query('SELECT count(*)::int AS n FROM platform_exercise_records WHERE kind=$1', ['case'])).rows[0].n);

    const response = await post('/api/operator/v1/commands/platform.openCase', { operationKey: randomUUID(), workspaceId: 'org_local_sample', kind: 'support', resourceId: null, reason: 'Cross-origin attempt.' }, { ...ownerHeaders, origin: 'https://foreign.example' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({error:{code:'origin_rejected'}});

    const after = await db.tenant('org_local_sample', async sql => (await sql.query('SELECT count(*)::int AS n FROM platform_exercise_records WHERE kind=$1', ['case'])).rows[0].n);
    expect(after).toBe(before);
  });

  it('returns unknown_command for prototype and unknown command names', async () => {
    const malicious = ['toString', 'constructor', '__proto__', 'platform.toString'];
    for (const name of malicious) {
      const response = await post(`/api/operator/v1/commands/${name}`, {});
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe('unknown_command');
    }
  });

  it('rejects openCase for a different workspace and stores no foreign rows', async () => {
    const foreignWorkspace = 'org_' + randomUUID().replaceAll('-', '');
    const response = await post('/api/operator/v1/commands/platform.openCase', { operationKey: randomUUID(), workspaceId: foreignWorkspace, kind: 'support', resourceId: null, reason: 'Attempt an unrelated workspace access.' });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('exercise_workspace_only');

    const foreignRows = await db.tenant(foreignWorkspace, async sql => (await sql.query('SELECT count(*)::int AS n FROM platform_exercise_records')).rows[0].n);
    expect(foreignRows).toBe(0);
  });

  it('returns operator_not_configured when platform runtime is absent', async () => {
    const app = createApp(config, service, auth);
    noPlatformServer = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const address = noPlatformServer.address();
    if (!address || typeof address === 'string') throw new Error('No secondary test server');
    const noPlatformOrigin = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${noPlatformOrigin}/api/operator/v1/commands/platform.overview`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({}) });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('operator_not_configured');

    await new Promise<void>(resolve => noPlatformServer!.close(() => resolve()));
    noPlatformServer = undefined;
  });
});
