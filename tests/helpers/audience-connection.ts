import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../../src/server/db.js';
import type { Actor } from '../../src/server/service.js';
import type { Capability } from '../../src/shared/contracts.js';

export async function makeAudienceConnection(
  db: Database,
  owner: Actor,
  brandIds: string[],
  scopes: Capability[] = ['audience:write'],
): Promise<{ id: string; actor: Actor }> {
  const id = randomUUID();
  const tokenHash = createHash('sha256').update(randomBytes(32)).digest('hex');

  await db.tenant(owner.workspaceId, async (sql) => {
    await sql.query(
      `INSERT INTO connections (workspace_id, id, name, issuer_id, token_hash, scopes, brand_ids, expires_at)
       VALUES ($1, $2, 'Audience test writer', $3, $4, $5, $6, now() + interval '1 day')`,
      [owner.workspaceId, id, owner.userId, tokenHash, scopes, brandIds],
    );
  });

  return {
    id,
    actor: { ...owner, kind: 'connection', actorId: `connection:${id}`, scopes, brandIds },
  };
}
