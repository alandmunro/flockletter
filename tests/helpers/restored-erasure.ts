import { Database } from '../../src/server/db.js';
import { randomUUID } from 'node:crypto';

export async function recordRestoredErasure(adminUrl: string, workspace: string): Promise<void> {
  const db = new Database(adminUrl);
  try {
    await db.tenant(workspace, async (sql) => {
      const jobId = randomUUID();
      await sql.query(
        `INSERT INTO customer_retention_receipts(workspace_id,job_id,effective_end_at,erased_at,manifest_digest,checkpoint_digest)
        VALUES($1,$2,now()-interval '90 days',now(),$3,$4)`,
        [workspace, jobId, 'a'.repeat(64), 'b'.repeat(64)],
      );
    });
  } finally {
    await db.close();
  }
}
