import pg from 'pg';
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
  async verifyBoundary() {
    const result = await this.pool.query<{ database: string; unsafe: boolean }>(`
      SELECT current_database() AS database, EXISTS (
        SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'MEMBER')
        AND (r.rolsuper OR r.rolbypassrls OR r.oid IN (SELECT relowner FROM pg_class WHERE relnamespace = 'public'::regnamespace))
      ) AS unsafe`);
    const row = result.rows[0];
    if (!row?.database.startsWith('flockletter_') || row.unsafe) throw new Error('Use a dedicated flockletter_ database and a restricted runtime role, separate from the migration owner.');
    const tables = await this.pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'");
    const required = ['workspaces', 'brands', 'campaigns', 'assets', 'connections', 'operations', 'audit'];
    if (required.some(name => !tables.rows.some(t => t.relname === name && t.relrowsecurity && t.relforcerowsecurity))) throw new Error('The foundation migration and forced tenant policies are required.');
    const privileges = await this.pool.query<{ unsafe: boolean }>("SELECT has_schema_privilege(current_user,'public','CREATE') OR has_database_privilege(current_user,current_database(),'CREATE') AS unsafe");
    if (privileges.rows[0]?.unsafe) throw new Error('The runtime role must not create schemas or tables.');
  }
  async close() { await this.pool.end(); }
}
