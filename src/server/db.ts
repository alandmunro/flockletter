import pg from 'pg';
import { verifyRuntimeBoundary } from './runtime-boundary.mjs';
import type { PoolClient } from 'pg';

export type Sql = Pick<PoolClient, 'query'>;
export class Database {
  readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 10000 }); }
  async tenant<T>(workspaceId: string, action: (sql: Sql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async verifyBoundary() { await verifyRuntimeBoundary(this.pool); }
  async brand<T>(workspaceId: string, brandId: string, action: (sql: Sql) => Promise<T>): Promise<T> {
    return this.tenant(workspaceId, async sql => {
      await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brandId]);
      return action(sql);
    });
  }
  async close() { await this.pool.end(); }
}
