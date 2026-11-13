import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import type { SenderStatus } from '../src/shared/sender.js';
import type { Workspace } from '../src/shared/contracts.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});
describe('sender domain ownership', () => {
  it('requires a brand-scoped exact challenge, resets changed domains, rate limits checks and never grants provider verification', async () => {
    let answer: string[][] = [];
    const service = new CommandService(db, undefined, undefined, async (name) => {
      expect(name).toBe('_flockletter.alpine.example.com');
      return answer;
    });
    const actor: Actor = {
      kind: 'session',
      owner: true,
      workspaceId: 'org_' + randomUUID(),
      userId: 'owner',
      actorId: 'user:owner',
      brandIds: null,
      scopes: ['read'],
    };
    await service.execute(
      'workspace.initialize',
      { name: 'Store', brandName: 'Alpine', operationKey: randomUUID() },
      actor,
    );
    const brandId = ((await service.execute('workspace.get', {}, actor)) as Workspace).brands[0]!.id;
    const save = (domain: string) =>
      service.execute(
        'sender.register',
        { brandId, domain, operationKey: randomUUID() },
        actor,
      ) as Promise<SenderStatus>;
    const verify = () =>
      service.execute(
        'sender.verify',
        { brandId, operationKey: randomUUID() },
        actor,
      ) as Promise<SenderStatus>;
    for (const invalid of [
      'https://alpine.example.com',
      'localhost',
      '192.168.1.1',
      'internal.local',
      'evil.com/path',
    ]) {
      await expect(save(invalid)).rejects.toThrow();
    }
    const brand = await save('Alpine.Example.Com');
    expect(brand).toMatchObject({
      domain: 'alpine.example.com',
      recordName: '_flockletter.alpine.example.com',
      status: 'awaiting_dns',
      providerVerified: false,
    });
    answer = [['unrelated'], [brand.recordValue!.slice(0, 7), brand.recordValue!.slice(7)]];
    expect(await verify()).toMatchObject({ status: 'ownership_verified', providerVerified: false });
    await expect(verify()).rejects.toMatchObject({ status: 429 });
    expect(await save('second.example.com')).toMatchObject({
      checkedAt: null, verifiedAt: null,
      status: 'awaiting_dns',
      providerVerified: false,
    });
    expect(
      await db
        .brand(actor.workspaceId, randomUUID(), (sql) => sql.query('SELECT domain FROM sender_domains'))
        .then((q) => q.rows),
    ).toEqual([]);
  });
});
