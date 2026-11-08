import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { recordAccess } from '../scripts/complimentary-access.js';
import { startDatabase } from '../scripts/database-fixture.js';
import { apiCaller, createMcpServer } from '../src/mcp/bridge.js';
import { createApp } from '../src/server/app.js';
import { Authenticator, type IdentityProvider } from '../src/server/auth.js';
import type {
  DeliveryEnvelope,
  DeliveryOutcome,
  DeliveryProvider,
} from '../src/server/campaign/delivery-provider.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { AppError } from '../src/server/errors.js';
import { CommandService, type Actor } from '../src/server/service.js';
import type { CommandName, Workspace } from '../src/shared/contracts.js';

export class RecordingProvider implements DeliveryProvider {
  readonly submitted: DeliveryEnvelope[] = [];
  readonly lookedUp: string[] = [];
  lookupResult: DeliveryOutcome = 'unknown';
  onSubmit: (message: DeliveryEnvelope) => Promise<DeliveryOutcome> = async () => 'accepted';

  async submit(message: DeliveryEnvelope): Promise<DeliveryOutcome> {
    this.submitted.push(message);
    return this.onSubmit(message);
  }

  async lookup(operationKey: string): Promise<DeliveryOutcome> {
    this.lookedUp.push(operationKey);
    return this.lookupResult;
  }
}

export async function startDeliveryFixture() {
  const fixture = await startDatabase();
  const db = new Database(fixture.url);
  const admin = new Database(fixture.adminUrl);
  const server = createServer();
  const sessions = new Map<string, { userId: string; workspaceId: string }>();
  const identity: IdentityProvider = {
    async session(request) {
      const session = sessions.get(request.get('authorization') ?? '');
      if (!session) throw new AppError(401, 'invalid_test_session', 'Unknown test session.');
      return session;
    },
    async isOwner(userId, workspaceId) {
      return [...sessions.values()].some(
        (session) => session.userId === userId && session.workspaceId === workspaceId,
      );
    },
  };
  async function close() {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([db.close(), admin.close()]);
    await fixture.stop();
  }
  try {
    await db.verifyBoundary();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Expected a loopback port.');
    const origin = 'http://127.0.0.1:' + address.port;
    const config = loadConfig({
      APP_ENV: 'local',
      APP_ORIGIN: origin,
      LOCAL_TEST_IDENTITY: 'true',
      DATABASE_URL: fixture.url,
    });
    const activeBindings = new Set<string>();
    const service = new CommandService(
      db,
      undefined,
      identity.isOwner,
      undefined,
      undefined,
      undefined,
      (w, b) => activeBindings.has(w + '/' + b),
    );
    server.on('request', createApp(config, service, new Authenticator(db, identity)));

    async function workspace() {
      const session = 'Bearer ' + randomUUID();
      const workspaceId = 'org_' + randomUUID().replaceAll('-', '');
      const userId = 'test-owner-' + workspaceId;
      sessions.set(session, { workspaceId, userId });
      const owner: Actor = {
        workspaceId,
        userId,
        actorId: 'user:' + userId,
        kind: 'session',
        owner: true,
        scopes: ['read'],
        brandIds: null,
      };
      const post = (name: CommandName, input: unknown) =>
        fetch(origin + '/api/v1/commands/' + name, {
          method: 'POST',
          headers: { authorization: session, 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
      async function command<T>(name: CommandName, input: unknown): Promise<T> {
        const response = await post(name, input);
        if (!response.ok) throw Error(name + ' failed: ' + response.status + ' ' + (await response.text()));
        return (await response.json()).result;
      }
      await service.execute(
        'workspace.initialize',
        {
          operationKey: randomUUID(),
          name: 'Delivery fixture',
          brandName: 'Trailhead',
        },
        owner,
      );
      const brandId = ((await service.execute('workspace.get', {}, owner)) as Workspace).brands[0]!.id;
      await recordAccess(admin, workspaceId, {
        workspaceId,
        plan: 'pro',
        operator: 'Fixture operator',
        reason: 'Synthetic worker check',
        operationKey: randomUUID(),
      });
      const { token } = (await service.execute(
        'connection.create',
        {
          operationKey: randomUUID(),
          name: 'Delivery report',
          brandIds: [brandId],
          expiresInDays: 1,
          scopes: ['read', 'campaign:rehearse', 'audience:summary', 'campaign:simulate'],
        },
        owner,
      )) as { token: string };
      const bridge = createMcpServer(apiCaller(origin, token));
      const client = new Client({ name: 'worker-acceptance', version: '1' });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await bridge.connect(serverSide);
      await client.connect(clientSide);
      async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
        const reply = await client.callTool({ name, arguments: args });
        const content = reply.content as { text: string }[];
        if (reply.isError) throw Error(name + ' failed: ' + content[0]?.text);
        return JSON.parse(content[0]!.text) as T;
      }
      activeBindings.add(workspaceId + '/' + brandId);
      return {
        owner,
        workspaceId,
        removeWorkerBinding: () => activeBindings.delete(workspaceId + '/' + brandId),
        brandId,
        post,
        command,
        tool,
        close: async () => {
          await client.close();
          await bridge.close();
        },
      };
    }
    return { db, identity, workspace, close };
  } catch (error) {
    await close();
    throw error;
  }
}
