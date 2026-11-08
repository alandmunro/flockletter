import pg from 'pg';
import { AppError,requireCondition } from './errors.js';
import { verifyRuntimeBoundary } from './runtime-boundary.mjs';
import type { PoolClient } from 'pg';

export type Sql = Pick<PoolClient, 'query'>;
export class Database {
  readonly pool: pg.Pool;
  private readonly disconnects = new Set<Promise<void>>();
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 10000 });
    this.pool.on('connect', client => {
      const ended = new Promise<void>(resolve => client.once('end', resolve));
      this.disconnects.add(ended);
      void ended.then(() => this.disconnects.delete(ended));
    });
  }
  async read<T>(workspaceId:string,action:(sql:Sql)=>Promise<T>):Promise<T>{
    return this.scoped(workspaceId,action,true);
  }
  async tenant<T>(workspaceId: string, action: (sql: Sql) => Promise<T>): Promise<T> {
    return this.scoped(workspaceId,action,false);
  }
  private async scoped<T>(workspaceId:string,action:(sql:Sql)=>Promise<T>,readOnly:boolean):Promise<T>{
    const client = await this.pool.connect();
    try {
      await client.query(readOnly?'BEGIN READ ONLY':'BEGIN');
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      requireCondition(!(await client.query('SELECT public.flockletter_retention_blocked($1) blocked',[workspaceId])).rows[0]?.blocked,410,'workspace_retention_blocked','This workspace is erased or quarantined. Protected recovery review is required.');
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK');if((error as {code?:string}).code==='55P03'&&(error as Error).message==='workspace_retention_busy')throw new AppError(503,'workspace_busy','Another workspace operation is finishing. Retry with the same operation key.');if((error as {code?:string;message?:string}).code==='55000'&&(error as Error).message==='workspace_retention_blocked')throw new AppError(410,'workspace_retention_blocked','This workspace is erased or quarantined. Protected recovery review is required.');throw error; }
    finally { client.release(); }
  }
  async verifyBoundary() { await verifyRuntimeBoundary(this.pool); }
  async brand<T>(workspaceId: string, brandId: string, action: (sql: Sql) => Promise<T>): Promise<T> {
    return this.tenant(workspaceId, async sql => {
      await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brandId]);
      return action(sql);
    });
  }
  async close() {
    // pg-pool can resolve end() after it removes an idle client but before its socket has closed.
    await this.pool.end();
    await Promise.all(this.disconnects);
  }
}
