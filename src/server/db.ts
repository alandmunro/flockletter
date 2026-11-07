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
    const required = ['workspaces', 'brands', 'campaigns', 'assets', 'connections', 'operations', 'audit',
      'subscriber_intake_settings', 'subscribers', 'subscriber_consent_events', 'subscriber_confirmation_tokens',
      'subscriber_outbox', 'subscriber_signup_operations', 'subscriber_rate_buckets', 'subscriber_feedback'];
    if (required.some(name => !tables.rows.some(t => t.relname === name && t.relrowsecurity && t.relforcerowsecurity))) throw new Error('The foundation migration and forced tenant policies are required.');
    const intakeTables=required.filter(name=>name==='subscribers'||name.startsWith('subscriber_'));
    const policies=await this.pool.query<{tablename:string;policyname:string;qual:string;with_check:string}>(
      "SELECT tablename,policyname,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1)",[intakeTables]);
    const boundary="workspace_id=current_setting'app.workspace_id'::text,trueANDbrand_id::text=current_setting'app.intake_brand_id'::text,true";
    if (policies.rowCount!==intakeTables.length || intakeTables.some(name=>!policies.rows.some(p=>
      p.tablename===name && p.policyname==='subscriber_brand_boundary' && p.qual===p.with_check &&
      p.qual?.replace(/[\s()]/g,'')===boundary))) throw new Error('The subscriber workspace and brand policies are required.');
    const privileges = await this.pool.query<{ unsafe: boolean }>("SELECT has_schema_privilege(current_user,'public','CREATE') OR has_database_privilege(current_user,current_database(),'CREATE') AS unsafe");
    if (privileges.rows[0]?.unsafe) throw new Error('The runtime role must not create schemas or tables.');
    const evidence = await this.pool.query("SELECT has_table_privilege(current_user,'subscriber_consent_events','UPDATE,DELETE,TRUNCATE') AS mutable");
    if (evidence.rows[0]?.mutable) throw new Error('Consent evidence must be append-only for the runtime role.');
  }
  async brand<T>(workspaceId: string, brandId: string, action: (sql: Sql) => Promise<T>): Promise<T> {
    return this.tenant(workspaceId, async sql => {
      await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brandId]);
      return action(sql);
    });
  }
  async close() { await this.pool.end(); }
}
