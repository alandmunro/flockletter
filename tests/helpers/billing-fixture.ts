import { randomUUID } from 'node:crypto';
import { startDatabase } from '../../scripts/database-fixture.js';
import { Database } from '../../src/server/db.js';
import type { Actor } from '../../src/server/service.js';

export interface BillingFixture {
  db: Database;
  adminUrl: string;
  actor(): Actor;
  close(): Promise<void>;
}

export async function startBillingFixture(): Promise<BillingFixture> {
  const fixture = await startDatabase();
  const db = new Database(fixture.url);

  return {
    db,
    adminUrl: fixture.adminUrl,
    actor() {
      const workspaceId = 'org_' + randomUUID().replaceAll('-', '');
      const userId = 'user_' + randomUUID();
      return {
        workspaceId,
        userId,
        actorId: 'user:' + userId,
        owner: true,
        kind: 'session',
        scopes: ['read'],
        brandIds: null,
      };
    },
    async close() {
      await db.close();
      await fixture.stop();
    },
  };
}
