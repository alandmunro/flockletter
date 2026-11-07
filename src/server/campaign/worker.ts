import type { Database } from '../db.js';
import { processDue, type CheckOwner, workspaceIdentifier } from './rehearsal.js';
import { z } from 'zod';

export function captureBinding(env: NodeJS.ProcessEnv) {
  const workspace = env.FLOCKLETTER_CAPTURE_WORKSPACE,
    brand = env.FLOCKLETTER_CAPTURE_BRAND;
  if (!workspace && !brand) return null;
  return { workspace: workspaceIdentifier.parse(workspace), brand: z.uuid().parse(brand).toLowerCase() };
}
export class CaptureWorker {
  constructor(
    private db: Database,
    private isOwner: CheckOwner,
  ) {}
  async tick(workspace: string, brand: string) {
    return this.db.brand(workspace, brand, async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [workspace]);
      return processDue(sql, workspace, brand, this.isOwner);
    });
  }
}
