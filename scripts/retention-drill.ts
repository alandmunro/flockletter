import { randomUUID } from 'node:crypto';
import pg from 'pg';
import tables from '../src/shared/runtime-tables.json' with { type: 'json' };
import { reviewDate, verifiedServiceEnd } from '../src/server/retention.js';
import { suppress } from '../src/server/subscribers/intake.js';
import { startDatabase } from './database-fixture.js';

const source = 'flockletter_test';
const restore = 'flockletter_retention_restore';
const control = 'postgres';
const tablesByName = tables.map(({ name }) => name).sort();
const brandTables = new Set(tables.filter(({ scope }) => scope === 'brand').map(({ name }) => name));
const fixtureId = /^org_retention_fixture_[a-z0-9_]{1,50}$/;
type Receipt = { workspace_id: string; effective_end_at: Date; erased_at: Date };
type SavedReceipt = { workspace_id: string; effective_end_at: string; erased_at: string };
type Suppression = {
  workspace_id: string;
  brand_id: string;
  id: string;
  state: 'unsubscribed' | 'hard_bounced' | 'complained';
  event_id: string;
  event: 'unsubscribed' | 'suppressed';
  purpose: string;
  policy_version: string;
  text_digest: string;
  origin: string;
  source_domain: string;
  recorded_at: string;
};
type Checkpoint = { erasures: SavedReceipt[]; suppressions: Suppression[] };

async function transaction<T>(db: pg.Client, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

// Review the manifest against the actual database before touching a row. This also catches
// future unscoped foreign keys whose cascade could otherwise cross a workspace boundary.
async function deletionOrder(db: pg.Client) {
  await db.query(
    'LOCK TABLE ' +
      tablesByName.map((name) => 'public.' + pg.escapeIdentifier(name)).join(', ') +
      ' IN SHARE ROW EXCLUSIVE MODE',
  );
  const relations = (
    await db.query<{ name: string; scoped: boolean }>(`
    SELECT c.relname AS name, EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND
      a.attname='workspace_id' AND a.attnotnull AND NOT a.attisdropped) AS scoped
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') ORDER BY name`)
  ).rows;
  if (
    relations.length !== tablesByName.length ||
    relations.some((r, i) => !r.scoped || r.name !== tablesByName[i])
  )
    throw Error('Review retention coverage for the current tenant tables.');
  const edges = (
    await db.query<{ child: string; parent: string; scoped: boolean }>(`
    SELECT c.relname AS child, p.relname AS parent, c.relnamespace='public'::regnamespace AND
      p.relnamespace='public'::regnamespace AND EXISTS (
        SELECT FROM generate_subscripts(f.conkey,1) AS k
        JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=f.conkey[k]
        JOIN pg_attribute b ON b.attrelid=f.confrelid AND b.attnum=f.confkey[k]
        WHERE a.attname='workspace_id' AND b.attname='workspace_id') AS scoped
    FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid
    WHERE f.contype='f' AND (c.relnamespace='public'::regnamespace OR p.relnamespace='public'::regnamespace)`)
  ).rows;
  if (edges.some((edge) => !edge.scoped)) throw Error('An unscoped foreign key prevents workspace erasure.');
  const pending = new Set(tablesByName);
  const order: string[] = [];
  while (pending.size) {
    const next = [...pending].find((name) => !edges.some((e) => e.parent === name && pending.has(e.child)));
    if (!next) throw Error('Review circular foreign keys before erasing workspace data.');
    pending.delete(next);
    order.push(next);
  }
  return order;
}

async function erase(db: pg.Client, order: string[], receipt: Receipt | SavedReceipt) {
  if (!fixtureId.test(receipt.workspace_id)) throw Error('Only a synthetic retention fixture can be erased.');
  await db.query('SET LOCAL ROLE flockletter_retention_operator');
  await db.query("SELECT set_config('app.workspace_id',$1,true)", [receipt.workspace_id]);
  const brands = (
    await db.query<{ id: string }>('SELECT id FROM brands WHERE workspace_id=$1 ORDER BY id', [
      receipt.workspace_id,
    ])
  ).rows;
  for (const name of order) {
    const remove = 'DELETE FROM public.' + pg.escapeIdentifier(name) + ' WHERE workspace_id=$1';
    if (brandTables.has(name)) {
      for (const { id } of brands) {
        await db.query("SELECT set_config('app.intake_brand_id',$1,true)", [id]);
        await db.query(remove + ' AND brand_id=$2', [receipt.workspace_id, id]);
      }
    } else {
      await db.query(remove, [receipt.workspace_id]);
    }
  }
  await db.query('RESET ROLE');
  const remaining = await db.query(
    'SELECT FROM (' +
      order
        .map((name) => 'SELECT 1 FROM public.' + pg.escapeIdentifier(name) + ' WHERE workspace_id=$1')
        .join(' UNION ALL ') +
      ') owned LIMIT 1',
    [receipt.workspace_id],
  );
  if (remaining.rowCount) throw Error('Erasure left workspace rows behind.');
  await db.query(
    `INSERT INTO retention_drill.erasures(workspace_id,effective_end_at,erased_at)
    VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO NOTHING`,
    [receipt.workspace_id, receipt.effective_end_at, receipt.erased_at],
  );
}

// This factory creates its own local cluster. It has no connection-string, environment or target argument.
export async function startRetentionDrill() {
  const fixture = await startDatabase();
  const marker = 'Flockletter synthetic retention ' + randomUUID();
  async function connect<T>(
    database: string,
    fn: (db: pg.Client) => Promise<T>,
    checkMarker = true,
  ): Promise<T> {
    const url = new URL(fixture.adminUrl);
    url.pathname = '/' + database;
    const db = new pg.Client({ connectionString: url.href });
    await db.connect();
    try {
      const identity = (
        await db.query(`SELECT current_user='postgres' AND inet_server_addr()='127.0.0.1'::inet AS local,
        datname,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`)
      ).rows[0];
      if (!identity?.local || identity.datname !== database || (checkMarker && identity.marker !== marker))
        throw Error('Disposable retention database identity could not be verified.');
      return await fn(db);
    } finally {
      await db.end();
    }
  }
  const identifier = (name: string) => pg.escapeIdentifier(name);
  const mark = (name: string) =>
    'COMMENT ON DATABASE ' + identifier(name) + ' IS ' + pg.escapeLiteral(marker);
  try {
    await connect(
      source,
      async (db) => {
        await db.query(mark(source));
        await db.query(`CREATE SCHEMA retention_drill;
        CREATE ROLE flockletter_retention_operator NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOBYPASSRLS;
        CREATE TABLE retention_drill.erasures(workspace_id text PRIMARY KEY, effective_end_at timestamptz NOT NULL,
          erased_at timestamptz NOT NULL);
        REVOKE ALL ON SCHEMA retention_drill FROM PUBLIC, flockletter_runtime;`);
        await db.query('GRANT USAGE ON SCHEMA public TO flockletter_retention_operator');
        await db.query(
          'GRANT SELECT,DELETE ON ' +
            tablesByName.map((name) => 'public.' + pg.escapeIdentifier(name)).join(', ') +
            ' TO flockletter_retention_operator',
        );
      },
      false,
    );
    await connect(
      control,
      async (db) => {
        await db.query(mark(control));
        await db.query(`REVOKE CONNECT ON DATABASE postgres FROM PUBLIC, flockletter_runtime;
        CREATE SCHEMA retention_drill;
        CREATE TABLE retention_drill.checkpoint(once boolean PRIMARY KEY CHECK(once), facts jsonb NOT NULL);
        REVOKE ALL ON SCHEMA retention_drill FROM PUBLIC, flockletter_runtime;`);
      },
      false,
    );
  } catch (error) {
    await fixture.stop();
    throw error;
  }

  return {
    fixture,
    async purge(workspace: string, asOf: Date) {
      if (!fixtureId.test(workspace) || !Number.isFinite(asOf.getTime()))
        throw Error('Invalid synthetic retention input.');
      return connect(source, (db) =>
        transaction(db, async () => {
          const order = await deletionOrder(db);
          const prior = (
            await db.query<Receipt>('SELECT * FROM retention_drill.erasures WHERE workspace_id=$1', [
              workspace,
            ])
          ).rows[0];
          if (prior) {
            await erase(db, order, prior);
            return { status: 'erased' as const, receipt: prior };
          }
          const effectiveEnd = await verifiedServiceEnd(db, workspace, asOf);
          if (!effectiveEnd || reviewDate(effectiveEnd) > asOf) return { status: 'retained' as const };
          const receipt = {
            workspace_id: workspace,
            effective_end_at: effectiveEnd,
            erased_at: asOf,
          };
          await erase(db, order, receipt);
          return { status: 'erased' as const, receipt };
        }),
      );
    },
    async takeSnapshot() {
      await connect(control, async (db) => {
        await db.query(`CREATE DATABASE ${restore} WITH TEMPLATE ${source} ALLOW_CONNECTIONS false`);
        await db.query(`REVOKE CONNECT ON DATABASE ${restore} FROM PUBLIC, flockletter_runtime`);
        await db.query(mark(restore));
        await db.query(`ALTER DATABASE ${restore} ALLOW_CONNECTIONS true`);
      });
    },
    // Freeze the source before taking the one authoritative checkpoint. A failed checkpoint leaves
    // the restore inaccessible. The destination can subsequently recover with the source offline.
    async sealCheckpoint() {
      await connect(source, async (db) => {
        await connect(control, (admin) => admin.query(`ALTER DATABASE ${source} ALLOW_CONNECTIONS false`));
        const others = await db.query(
          'SELECT FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
        );
        if (others.rowCount) throw Error('Close fixture clients before sealing the recovery checkpoint.');
        const erasures = (
          await db.query<Receipt>('SELECT * FROM retention_drill.erasures ORDER BY workspace_id')
        ).rows;
        const suppressions = (
          await db.query<Suppression>(`
          SELECT s.workspace_id,s.brand_id,s.id,s.state,e.id AS event_id,e.event,e.purpose,e.policy_version,
            e.text_digest,e.source AS origin,e.source_domain,e.recorded_at
          FROM subscribers s LEFT JOIN LATERAL (
            SELECT * FROM subscriber_consent_events e WHERE e.workspace_id=s.workspace_id AND e.brand_id=s.brand_id
            AND e.subscriber_id=s.id AND e.event=CASE WHEN s.state='unsubscribed' THEN 'unsubscribed' ELSE 'suppressed' END
            ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1) e ON true
          WHERE s.state IN ('unsubscribed','hard_bounced','complained') ORDER BY s.workspace_id,s.brand_id,s.id`)
        ).rows;
        if (suppressions.some((s) => !s.event_id || !fixtureId.test(s.workspace_id)))
          throw Error('Every synthetic suppression needs attributable evidence before recovery.');
        await connect(control, (journal) =>
          journal.query('INSERT INTO retention_drill.checkpoint(once,facts) VALUES(true,$1)', [
            { erasures, suppressions },
          ]),
        );
      });
    },
    async reconcileRestore() {
      const facts = await connect(
        control,
        async (db) =>
          (await db.query<{ facts: Checkpoint }>('SELECT facts FROM retention_drill.checkpoint WHERE once'))
            .rows[0]?.facts,
      );
      if (!facts) throw Error('A sealed retention checkpoint is required before restoring access.');
      await connect(restore, (db) =>
        transaction(db, async () => {
          const order = await deletionOrder(db);
          for (const receipt of facts.erasures) await erase(db, order, receipt);
          await db.query('SET LOCAL ROLE flockletter_runtime');
          for (const row of facts.suppressions) {
            await db.query(
              "SELECT set_config('app.workspace_id',$1,true),set_config('app.intake_brand_id',$2,true)",
              [row.workspace_id, row.brand_id],
            );
            // A contact first created after the snapshot does not exist there. Never recreate a recipient.
            const found = await db.query('SELECT FROM subscribers WHERE id=$1', [row.id]);
            if (!found.rowCount) continue;
            await db.query(
              `INSERT INTO subscriber_consent_events
            (workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain,recorded_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(workspace_id,brand_id,id) DO NOTHING`,
              [
                row.workspace_id,
                row.brand_id,
                row.event_id,
                row.id,
                row.event,
                row.purpose,
                row.policy_version,
                row.text_digest,
                row.origin,
                row.source_domain,
                row.recorded_at,
              ],
            );
            await suppress(db, row.id, row.event_id, row.state, 'retention-restore');
          }
          await db.query('RESET ROLE');
          await db.query(`GRANT CONNECT ON DATABASE ${restore} TO flockletter_runtime`);
        }),
      );
    },
  };
}
