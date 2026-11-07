import type { PoolClient } from 'pg';
export function verifyRuntimeBoundary(
  client: Pick<PoolClient,'query'>,
  expected?:{database?:string;role?:string},
):Promise<{database:string;role:string;protected_tables:number;schema_create:false;database_create:false}>;
