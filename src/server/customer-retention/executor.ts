import { createHash } from 'node:crypto';
import pg from 'pg';
import tables from '../../shared/runtime-tables.json' with { type: 'json' };
import type { ServiceEnd } from '../../shared/customer-retention.js';
import { reviewDate } from '../retention.js';
import { retentionManifestDigest } from './index.js';

export type RetentionAuthorization = {
  workspaceId: string;
  jobId: string;
  sourceVersion: string;
  databaseName: string;
  manifestDigest: string;
  checkpointDigest: string;
  authorizedBy: string;
  expiresAt: Date;
};
export type RetentionExecutorOptions = {
  databaseName: string;
  executorRole: string;
  enabled: boolean;
  serviceEnd: (sql: pg.Client, workspace: string) => Promise<ServiceEnd>;
  verifyCheckpoint: (workspace: string, digest: string) => Promise<boolean>;
  verifyExternalStores: (workspace: string) => Promise<boolean>;
  now?: () => Date;
  verifyLockedPlan?: (sql: pg.Client, workspace:string, job:string) => Promise<void>;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = (value: string) => pg.escapeIdentifier(value);
const names = tables.map((t) => t.name).sort();

async function privileged(db: pg.Client, options: RetentionExecutorOptions) {
  if (
    !options.enabled ||
    !/^flockletter_[a-z0-9_]+$/.test(options.executorRole) ||
    !/^flockletter_[a-z0-9_]+$/.test(options.databaseName)
  )
    throw Error('Configure the dedicated erasure executor and exact Flockletter database.');
  const info = (
    await db.query(`SELECT current_database() database,current_user role,r.rolsuper,r.rolbypassrls,
    has_table_privilege(current_user,'flockletter_retention_control.authorizations','SELECT') AND
    has_table_privilege(current_user,'flockletter_retention_control.authorizations','INSERT') AND
    has_table_privilege(current_user,'flockletter_retention_control.authorizations','UPDATE') authority
    FROM pg_roles r WHERE r.rolname=current_user`)
  ).rows[0];
  if (
    info?.database !== options.databaseName ||
    info.role !== options.executorRole ||
    info.rolsuper ||
    info.rolbypassrls ||
    !info.authority
  )
    throw Error('Separate restricted erasure authority is required.');
}

export async function authorizeRetention(
  db: pg.Client,
  options: RetentionExecutorOptions,
  approval: RetentionAuthorization,
) {
  await privileged(db, options);
  const now = options.now?.() ?? new Date();
  if (
    approval.databaseName !== options.databaseName ||
    approval.manifestDigest !== retentionManifestDigest() ||
    !/^[a-f0-9]{64}$/.test(approval.checkpointDigest) ||
    !approval.authorizedBy.trim() ||
    approval.expiresAt <= now ||
    approval.expiresAt.getTime() > now.getTime() + 3600000
  )
    throw Error(
      'The erasure authorization must identify the current manifest, protected checkpoint and a short expiry.',
    );
  if (!(await options.verifyCheckpoint(approval.workspaceId, approval.checkpointDigest)))
    throw Error('A protected recovery checkpoint is required before erasure.');
  if (!(await options.verifyExternalStores(approval.workspaceId)))
    throw Error('Verify external provider, export and engine copies before application erasure.');
  await db.query(
    `INSERT INTO flockletter_retention_control.authorizations(workspace_id,job_id,source_version,database_name,
    manifest_digest,checkpoint_digest,authorized_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(workspace_id,job_id) DO NOTHING`,
    [
      approval.workspaceId,
      approval.jobId,
      approval.sourceVersion,
      approval.databaseName,
      approval.manifestDigest,
      approval.checkpointDigest,
      approval.authorizedBy,
      approval.expiresAt,
    ],
  );
  const existing = (
    await db.query(
      'SELECT * FROM flockletter_retention_control.authorizations WHERE workspace_id=$1 AND job_id=$2',
      [approval.workspaceId, approval.jobId],
    )
  ).rows[0];
  if (
    !existing ||
    existing.source_version !== approval.sourceVersion ||
    existing.database_name !== approval.databaseName ||
    existing.manifest_digest !== approval.manifestDigest ||
    existing.checkpoint_digest !== approval.checkpointDigest ||
    existing.authorized_by !== approval.authorizedBy ||
    existing.expires_at.getTime() !== approval.expiresAt.getTime()
  )
    throw Error('The operation already has a different erasure authorization.');
}

async function deletionOrder(db: pg.Client) {
  const found = (
    await db.query<{ name: string; scoped: boolean; rls: boolean }>(`
    SELECT c.relname name,c.relrowsecurity AND c.relforcerowsecurity rls,
      EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND a.attnotnull AND NOT a.attisdropped) scoped
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') ORDER BY c.relname`)
  ).rows;
  if (
    found.length !== names.length ||
    found.some((row, i) => row.name !== names[i] || !row.scoped || !row.rls)
  )
    throw Error('The reviewed tenant manifest must cover every current protected table.');
  const edges = (
    await db.query<{ child: string; parent: string; scoped: boolean }>(`
    SELECT c.relname child,p.relname parent,
      c.relnamespace='public'::regnamespace AND p.relnamespace='public'::regnamespace AND EXISTS(
        SELECT FROM generate_subscripts(f.conkey,1) k
        JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=f.conkey[k]
        JOIN pg_attribute b ON b.attrelid=f.confrelid AND b.attnum=f.confkey[k]
        WHERE a.attname='workspace_id' AND b.attname='workspace_id') scoped
    FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid
    WHERE f.contype='f' AND (c.relnamespace='public'::regnamespace OR p.relnamespace='public'::regnamespace)`)
  ).rows;
  if (edges.some((edge) => !edge.scoped)) throw Error('An unscoped association prevents tenant erasure.');
  const pending = new Set(names),
    order: string[] = [];
  while (pending.size) {
    const next = [...pending].find(
      (name) => !edges.some((edge) => edge.parent === name && pending.has(edge.child)),
    );
    if (!next) throw Error('Circular tenant associations require an erasure review.');
    pending.delete(next);
    order.push(next);
  }
  return order;
}

// This entry point is deliberately absent from customer HTTP and MCP. The caller supplies
// an independently authorized operator connection and checkpoint verifier.
export async function executeAuthorizedRetention(
  db: pg.Client,
  options: RetentionExecutorOptions,
  workspace: string,
  job: string,
) {
  await privileged(db, options);
  const now = options.now?.() ?? new Date();
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [workspace]);
    await db.query("SELECT set_config('app.workspace_id',$1,true)", [workspace]);
    const receipt = (
      await db.query(
        'SELECT * FROM flockletter_retention_control.receipts WHERE workspace_id=$1 AND job_id=$2',
        [workspace, job],
      )
    ).rows[0];
    if (receipt) {
      await db.query('COMMIT');
      return { erased: true, replayed: true, at: receipt.erased_at.toISOString() };
    }
    if (
      (await db.query('SELECT FROM customer_retention_receipts WHERE workspace_id=$1 LIMIT 1', [workspace]))
        .rowCount
    )
      throw Error('An erased account requires protected restore reconciliation.');
    const approval = (
      await db.query(
        `SELECT * FROM flockletter_retention_control.authorizations
      WHERE workspace_id=$1 AND job_id=$2 AND completed_at IS NULL FOR UPDATE`,
        [workspace, job],
      )
    ).rows[0];
    if (
      !approval ||
      approval.database_name !== options.databaseName ||
      approval.expires_at <= now ||
      approval.manifest_digest !== retentionManifestDigest()
    )
      throw Error('A current exact-target authorization is required.');
    if (!(await options.verifyCheckpoint(workspace, approval.checkpoint_digest)))
      throw Error('The protected checkpoint is unavailable.');
    if (!(await options.verifyExternalStores(workspace)))
      throw Error('External-store erasure evidence is unavailable.');
    const fact = await options.serviceEnd(db, workspace);
    if (
      fact.source === 'complimentary' ||
      !fact.effectiveEnd ||
      fact.version !== approval.source_version ||
      !['canceled', 'cancelled', 'closed'].includes(fact.status) ||
      reviewDate(new Date(fact.effectiveEnd)) > now
    )
      throw Error('The current service end is ineligible for erasure.');
    const requested = (
      await db.query(
        `SELECT j.*,c.hold_reason,c.source_version,c.state case_state
      FROM customer_retention_jobs j JOIN customer_retention_cases c ON (c.workspace_id,c.id)=(j.workspace_id,j.case_id)
      WHERE j.workspace_id=$1 AND j.id=$2 FOR UPDATE OF j,c`,
        [workspace, job],
      )
    ).rows[0];
    if (
      !requested ||
      requested.hold_reason ||
      requested.source_version !== fact.version ||
      requested.state !== 'awaiting_operator' ||
      requested.case_state !== 'awaiting_operator' ||
      requested.manifest_digest !== approval.manifest_digest
    )
      throw Error('A due, reviewed retention request without a hold is required.');
    // Freeze schema and tenant data against concurrent writes before the reviewed deletion.
    await db.query(
      'LOCK TABLE ' +
        names.map((name) => 'public.' + identifier(name)).join(',') +
        ' IN SHARE ROW EXCLUSIVE MODE',
    );
    await options.verifyLockedPlan?.(db,workspace,job);
    for(const route of ['scopes','support_reply_routes']) {
      const qualified='flockletter_customer_jobs.'+identifier(route);
      if((await db.query('SELECT to_regclass($1) present',['flockletter_customer_jobs.'+route])).rows[0]?.present){
        const allowed=(await db.query("SELECT has_table_privilege(current_user,$1,'DELETE') AND has_table_privilege(current_user,$1,'SELECT') allowed",['flockletter_customer_jobs.'+route])).rows[0]?.allowed;
        if(!allowed)throw Error('Separate executor authority must cover every private workspace route.');
        await db.query('DELETE FROM '+qualified+' WHERE workspace_id=$1',[workspace]);
      }
    }
    if((await db.query("SELECT to_regclass('flockletter_retention_control.platform_records') present")).rows[0]?.present){
      const allowed=(await db.query("SELECT has_table_privilege(current_user,'flockletter_retention_control.platform_records','DELETE') AND has_table_privilege(current_user,'flockletter_retention_control.platform_records','SELECT') allowed")).rows[0]?.allowed;
      if(!allowed)throw Error('Separate executor authority must cover private operator case records.');
      await db.query('DELETE FROM flockletter_retention_control.platform_records WHERE workspace_id=$1',[workspace]);
    }
    const order = await deletionOrder(db);
    const brands = (
      await db.query<{ id: string }>('SELECT id FROM brands WHERE workspace_id=$1', [workspace])
    ).rows;
    let deletedRows = 0;
    for (const name of order) {
      const remove = 'DELETE FROM public.' + identifier(name) + ' WHERE workspace_id=$1';
      if (tables.find((t) => t.name === name)?.scope === 'brand') {
        for (const brand of brands) {
          await db.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand.id]);
          deletedRows += (await db.query(remove + ' AND brand_id=$2', [workspace, brand.id])).rowCount ?? 0;
        }
      } else deletedRows += (await db.query(remove, [workspace])).rowCount ?? 0;
    }
    const remaining = (
      await db.query(
        'SELECT FROM (' +
          names
            .map((name) => 'SELECT 1 FROM public.' + identifier(name) + ' WHERE workspace_id=$1')
            .join(' UNION ALL ') +
          ') rows LIMIT 1',
        [workspace],
      )
    ).rowCount;
    if (remaining) throw Error('Workspace data remains after erasure.');
    await db.query(
      `INSERT INTO flockletter_retention_control.receipts(workspace_id,job_id,source_version,erased_at,manifest_digest,checkpoint_digest)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [workspace, job, fact.version, now, approval.manifest_digest, approval.checkpoint_digest],
    );
    await db.query(
      'UPDATE flockletter_retention_control.authorizations SET completed_at=$3 WHERE workspace_id=$1 AND job_id=$2',
      [workspace, job, now],
    );
    await db.query('COMMIT');
    return {
      erased: true,
      replayed: false,
      at: now.toISOString(),
      deletedRows,
      scope: 'application_database' as const,
    };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export const protectedCheckpointDigest = (facts: {
  erasedWorkspaces: string[];
  suppressionVersion: string;
}) => digest(facts);
