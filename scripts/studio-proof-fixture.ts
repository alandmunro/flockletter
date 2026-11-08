import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { studioFixtureImage } from './studio-fixture-image.js';
import { createApp } from '../src/server/app.js';
import { Authenticator, localIdentity, type IdentityProvider } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { PrivateListmonk, type PrivateEngine } from '../src/server/campaign/private-listmonk.js';
import { CommandService, type Actor } from '../src/server/service.js';
import type { AssetSummary, Capability, CommandName, Workspace } from '../src/shared/contracts.js';
import { startDatabase } from './database-fixture.js';

export const keyed = <T extends object>(fields: T) => ({ ...fields, operationKey: randomUUID() });

export async function startStudioProof(privateEngine?: PrivateEngine) {
  const fixture = await startDatabase();
  const db = new Database(fixture.url);
  const server = createServer();
  async function close() {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await fixture.stop();
  }

  try {
    await db.verifyBoundary();
    const owner: Actor = {
      workspaceId: 'org_local_sample',
      userId: 'local_owner',
      actorId: 'user:local_owner',
      kind: 'session',
      owner: true,
      scopes: ['read'],
      brandIds: null,
    };
    const other: Actor = {
      ...owner,
      workspaceId: 'org_other_studio_sample',
      userId: 'other_owner',
      actorId: 'user:other_owner',
    };
    const local = localIdentity(),
      otherSession = randomUUID();
    const identity: IdentityProvider = {
      async session(req) {
        if (req.get('authorization') === 'Bearer ' + otherSession)
          return { userId: other.userId, workspaceId: other.workspaceId };
        return local.session(req);
      },
      async isOwner(user, workspace) {
        return (user === other.userId && workspace === other.workspaceId) || local.isOwner(user, workspace);
      },
    };
    const service = new CommandService(db, undefined, identity.isOwner);
    async function brand(actor: Actor, name: string) {
      await service.execute('workspace.initialize', keyed({ name, brandName: name }), actor);
      return ((await service.execute('workspace.get', {}, actor)) as Workspace).brands[0]!.id;
    }
    const brandId = await brand(owner, 'Trail Post');
    const otherBrandId = await brand(other, 'Another Studio');
    const siblingBrandId = randomUUID();
    await db.tenant(owner.workspaceId, (sql) =>
      sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
        owner.workspaceId,
        siblingBrandId,
        'Private brand',
      ]),
    );

    async function photo(actor: Actor, brandId: string, name: string, background: string) {
      const bytes = await studioFixtureImage(background);
      const input = keyed({
        brandId,
        files: [{ itemKey: randomUUID(), name, base64: bytes.toString('base64') }],
      });
      const uploaded = (await service.execute('asset.uploadBatch', input, actor)) as {
        results: { ok: boolean; asset?: AssetSummary }[];
      };
      const first = uploaded.results[0];
      if (!first?.ok || !first.asset) throw Error('Could not prepare the synthetic image.');
      return { asset: first.asset, bytes };
    }
    const front = await photo(owner, brandId, 'Trailhead front.png', '#8b4764');
    const back = await photo(owner, brandId, 'Trailhead back.png', '#9eb8c2');
    const foreign = await photo(other, otherBrandId, 'Another shop.png', '#324555');
    const sibling = await photo(owner, siblingBrandId, 'Private brand.png', '#dd8877');
    async function connection(scopes: Capability[]) {
      const grant = (await service.execute(
        'connection.create',
        keyed({
          name: 'Local Studio proof',
          scopes,
          brandIds: [brandId],
          expiresInDays: 1,
        }),
        owner,
      )) as { token: string };
      return grant.token;
    }

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Expected loopback HTTP.');
    const origin = 'http://127.0.0.1:' + address.port;
    const config = loadConfig({
      APP_ENV: 'local',
      APP_ORIGIN: origin,
      LOCAL_TEST_IDENTITY: 'true',
      DATABASE_URL: fixture.url,
    });
    const commands = privateEngine
      ? new CommandService(
          db,
          undefined,
          identity.isOwner,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          new PrivateListmonk(
            db,
            identity.isOwner,
            { workspace: owner.workspaceId, brand: brandId },
            privateEngine,
          ),
        )
      : service;
    server.on('request', createApp(config, commands, new Authenticator(db, identity)));
    function post(name: CommandName, input: unknown, token = 'local-development-only') {
      return fetch(origin + '/api/v1/commands/' + name, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    }
    async function command<T>(name: CommandName, input: unknown, token?: string): Promise<T> {
      const response = await post(name, input, token);
      if (!response.ok) throw Error(name + ': ' + response.status + ' ' + (await response.text()));
      return ((await response.json()) as { result: T }).result;
    }
    return {
      db,
      owner,
      other,
      otherSession,
      brandId,
      otherBrandId,
      siblingBrandId,
      front,
      back,
      foreign,
      sibling,
      connection,
      origin,
      post,
      command,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
