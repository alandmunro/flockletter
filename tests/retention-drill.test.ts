import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { startRetentionDrill } from '../scripts/retention-drill.js';
import { verifiedServiceEnd } from '../src/server/retention.js';
import tables from '../src/shared/runtime-tables.json' with { type: 'json' };
import { Database } from '../src/server/db.js';
import { unsubscribeContact } from '../src/server/subscribers/audience.js';
import { suppress } from '../src/server/subscribers/intake.js';

const closed = 'org_retention_fixture_closed';
const active = 'org_retention_fixture_active';
const brand = 'eb5405bc-4333-446d-9b60-89930578f273';
const secondBrand = 'ad2e96b9-16fb-491f-89c2-114d8874a6bd';
const contact = 'e22d0e05-aa03-4754-b93b-cd48e42ef72c';
const effectiveEnd = '2028-01-01T12:00:00.000Z';
const deadline = new Date('2028-03-31T12:00:00.000Z');

async function use<T>(url: string, fn: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
function database(url: string, name: string) {
  const target = new URL(url);
  target.pathname = '/' + name;
  return target.href;
}

// The two tenants deliberately share a brand UUID, subscriber UUID and address. Coverage
// inventories every runtime table, including data stored without a foreign key to workspaces.
async function seed(db: pg.Client, workspace: string) {
  await db.query('BEGIN');
  try {
    await db.query(
      "SELECT set_config('app.workspace_id',$1,true),set_config('app.intake_brand_id',$2,true),set_config('drill.contact',$3,true)",
      [workspace, brand, contact],
    );
    await db.query(`DO $$ DECLARE w text:=current_setting('app.workspace_id'); b uuid:=current_setting('app.intake_brand_id');
      s uuid:=current_setting('drill.contact'); conn uuid:=gen_random_uuid(); ev uuid:=gen_random_uuid();
      signup uuid:=gen_random_uuid(); optout uuid:=gen_random_uuid(); job uuid:=gen_random_uuid();
      camp uuid:=gen_random_uuid(); run uuid:=gen_random_uuid(); op uuid:=gen_random_uuid(); seg uuid:=gen_random_uuid();
      digest text:=repeat('a',64);
    BEGIN
      INSERT INTO workspaces(workspace_id,name) VALUES(w,'Fixture company');
      INSERT INTO brands(workspace_id,id,name) VALUES(w,b,'Fixture brand');
      INSERT INTO campaigns(workspace_id,id,brand_id,content) VALUES(w,camp,b,'{"subject":"Fixture draft"}');
      INSERT INTO assets(workspace_id,id,brand_id,item_key,name,mime,bytes,sha256,width,height)
        VALUES(w,gen_random_uuid(),b,'fixture-image','fictional.png','image/png',decode('0102','hex'),digest,1,1);
      INSERT INTO connections(workspace_id,id,name,issuer_id,token_hash,scopes,brand_ids,expires_at)
        VALUES(w,conn,'Fixture grant','fixture',digest,ARRAY['subscriber:signup'],ARRAY[b],now()+interval '1 day');
      INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result)
        VALUES(w,'fixture','op',digest,'{"address":"same@example.test"}');
      INSERT INTO audit(workspace_id,id,actor_id,action) VALUES(w,gen_random_uuid(),'fixture','save');
      INSERT INTO subscriber_intake_settings(workspace_id,brand_id) VALUES(w,b);
      INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES(w,b,s,'same@example.test','confirmed');
      INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain)
        VALUES(w,b,ev,s,'signup_requested','brand_marketing','v1',digest,'fixture','example.test');
      INSERT INTO subscriber_confirmation_tokens(workspace_id,brand_id,id,subscriber_id,action,token_hash,request_event_id,expires_at)
        VALUES(w,b,signup,s,'confirm',digest,ev,now()+interval '1 day'),(w,b,optout,s,'unsubscribe',digest,ev,NULL);
      INSERT INTO subscriber_outbox(workspace_id,brand_id,id,subscriber_id,connection_id,token_id,unsubscribe_id,mode)
        VALUES(w,b,job,s,conn,signup,optout,'capture');
      INSERT INTO subscriber_signup_operations(workspace_id,brand_id,connection_id,operation_key,request_digest,response)
        VALUES(w,b,conn,'signup',digest,'{}');
      INSERT INTO subscriber_rate_buckets VALUES(w,b,'fixture',now(),1);
      INSERT INTO subscriber_feedback(workspace_id,brand_id,event_id,job_id) VALUES(w,b,'fixture-feedback',job);
      INSERT INTO subscriber_marketing_links(workspace_id,brand_id,id,subscriber_id,signer_fingerprint,token_hash)
        VALUES(w,b,gen_random_uuid(),s,digest,digest);
      INSERT INTO workspace_access_events(workspace_id,revision,operation_key,plan,operator_name,reason)
        VALUES(w,1,gen_random_uuid(),'starter','fixture','Fixture grant'),(w,2,gen_random_uuid(),NULL,'fixture','Fixture revocation');
      INSERT INTO campaign_rehearsals(workspace_id,brand_id,id,campaign_id,version,content,render_html,render_text,
        creator_id,actor_id,audience,access_revision,selected,excluded,due_at,period,transport,provider_binding)
        VALUES(w,b,run,camp,1,'{}','<p>Fixture</p>','Fixture','fixture','fixture','confirmed',1,1,0,now(),CURRENT_DATE,'listmonk_test',digest);
      INSERT INTO rehearsal_recipients(workspace_id,brand_id,rehearsal_id,id,subscriber_id,email_digest) VALUES(w,b,run,op,s,digest);
      INSERT INTO rehearsal_reservations(workspace_id,brand_id,rehearsal_id,period,slots,messages) VALUES(w,b,run,CURRENT_DATE,1,1);
      INSERT INTO listmonk_handoffs(workspace_id,brand_id,rehearsal_id,operation_key,reference,reviewed_address,render_attempts)
        VALUES(w,b,run,op,'fl-'||repeat('a',56)||'@receipt.test','same@example.test',1);
      INSERT INTO campaign_provider_receipts(workspace_id,brand_id,rehearsal_id,operation_key,provider_binding,message_id)
        VALUES(w,b,run,op,digest,'fixture-message');
      INSERT INTO campaign_provider_events(workspace_id,brand_id,operation_key,event_id,kind) VALUES(w,b,op,'fixture-event','delivered');
      INSERT INTO delivery_test_receipts(workspace_id,brand_id,rehearsal_id,operation_key,message_digest) VALUES(w,b,run,op,digest);
      INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge) VALUES(w,b,'example.test',gen_random_uuid());
      INSERT INTO sandbox_checkouts(workspace_id,id,operation_key,actor_id,plan,sandbox_account,provider_price,status,observed_at,effective_end_at)
        VALUES(w,gen_random_uuid(),gen_random_uuid(),'fixture','starter','fixture','fixture','canceled','2028-01-01 12:00:00Z','2028-01-01 12:00:00Z');
      INSERT INTO sandbox_events(workspace_id,event_id,kind,digest) VALUES(w,'fixture','subscription',digest);
      INSERT INTO sandbox_portal_intents(workspace_id,operation_key,actor_id,customer_id) VALUES(w,gen_random_uuid(),'fixture','fixture');
      INSERT INTO sandbox_expired_checkouts(workspace_id,id,operation_key,actor_id,plan,sandbox_account,provider_price,session_id,
        observed_at,replacement_id,restart_key,restart_actor,restart_plan)
        VALUES(w,gen_random_uuid(),gen_random_uuid(),'fixture','starter','fixture','fixture','fixture',now(),gen_random_uuid(),gen_random_uuid(),'fixture','starter');
      INSERT INTO team_grants(workspace_id,user_id,permission,updated_by) VALUES(w,'member','viewer','fixture');
      INSERT INTO team_grant_brands(workspace_id,user_id,brand_id) VALUES(w,'member',b);
      INSERT INTO audience_segments(workspace_id,brand_id,id,name,slot) VALUES(w,b,seg,'Fixture group',1);
      INSERT INTO audience_segment_members VALUES(w,b,seg,s);
    END $$;`);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function rowsByTable(client: pg.Client, workspace: string): Promise<Record<string, object[]>> {
  const rows = (
    await client.query(
      tables
        .map(
          ({ name }) =>
            `SELECT '${name}' AS tbl, COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS data
     FROM public.${pg.escapeIdentifier(name)} t WHERE t.workspace_id=$1`,
        )
        .join(' UNION ALL '),
      [workspace],
    )
  ).rows;
  return Object.fromEntries(rows.map(({ tbl, data }) => [tbl, data]));
}

describe('disposable retention and recovery', () => {
  it('erases one due workspace transactionally and reapplies its receipt and a later opt-out before restoring access', async () => {
    const drill = await startRetentionDrill();
    const { adminUrl, url } = drill.fixture;
    const restored = database(url, 'flockletter_retention_restore');
    try {
      await use(adminUrl, async (db) => {
        await seed(db, closed);
        await seed(db, active);
        await db.query(
          "UPDATE sandbox_checkouts SET status='active',effective_end_at=NULL WHERE workspace_id=$1",
          [active],
        );
        for (const workspace of [closed, active]) {
          await db.query("INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,'Secondary brand')", [
            workspace,
            secondBrand,
          ]);
          await db.query(
            "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'same@example.test','confirmed')",
            [workspace, secondBrand, contact],
          );
        }
      });
      const original = await use(adminUrl, (db) => rowsByTable(db, closed));
      expect(Object.values(original).every((rows) => rows.length > 0)).toBe(true);
      const neighbor = await use(adminUrl, (db) => rowsByTable(db, active));
      await drill.takeSnapshot();
      await expect(use(restored, (db) => db.query('SELECT 1'))).rejects.toMatchObject({ code: '42501' });
      await expect(drill.reconcileRestore()).rejects.toThrow('sealed retention checkpoint');
      await expect(drill.purge(closed, new Date(deadline.getTime() - 1))).resolves.toEqual({
        status: 'retained',
      });
      await expect(drill.purge(active, deadline)).resolves.toEqual({ status: 'retained' });
      await use(adminUrl, async (db) => {
        // This trigger fails on a parent after its populated children have been deleted.
        await db.query(`CREATE FUNCTION retention_drill.inject_failure() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'injected retention failure'; END $$;
          CREATE TRIGGER retention_test_failure BEFORE DELETE ON workspaces FOR EACH ROW EXECUTE FUNCTION retention_drill.inject_failure();`);
      });
      await expect(drill.purge(closed, deadline)).rejects.toThrow('injected retention failure');
      await use(adminUrl, async (db) => {
        expect(await rowsByTable(db, closed)).toEqual(original);
        expect((await db.query('SELECT FROM retention_drill.erasures')).rowCount).toBe(0);
        await db.query('DROP TRIGGER retention_test_failure ON workspaces');
      });
      const expected = {
        status: 'erased',
        receipt: { workspace_id: closed, effective_end_at: new Date(effectiveEnd), erased_at: deadline },
      };
      expect(await Promise.all([drill.purge(closed, deadline), drill.purge(closed, deadline)])).toEqual([
        expected,
        expected,
      ]);
      await use(adminUrl, async (db) => {
        expect(Object.values(await rowsByTable(db, closed)).every((rows) => rows.length === 0)).toBe(true);
        expect(await rowsByTable(db, active)).toEqual(neighbor);
        expect((await db.query('SELECT FROM retention_drill.erasures')).rowCount).toBe(1);
      });
      const runtime = new Database(url);
      try {
        await runtime.brand(active, brand, (sql) => unsubscribeContact(sql, contact));
        await runtime.brand(active, secondBrand, (sql) =>
          suppress(sql, contact, null, 'complained', 'campaign-feedback_test'),
        );
        await expect(
          runtime.tenant(active, (sql) => sql.query('DELETE FROM workspaces')),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await runtime.close();
      }
      await drill.sealCheckpoint();
      await expect(use(adminUrl, (db) => db.query('SELECT 1'))).rejects.toMatchObject({ code: '55000' });
      await expect(use(database(url, 'postgres'), (db) => db.query('SELECT 1'))).rejects.toMatchObject({
        code: '42501',
      });
      const restoreAdmin = database(adminUrl, 'flockletter_retention_restore');
      await use(restoreAdmin, (db) =>
        db.query(`CREATE FUNCTION retention_drill.inject_failure() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected replay failure'; END $$;
        CREATE TRIGGER reject_opt_out BEFORE UPDATE ON subscribers FOR EACH ROW EXECUTE FUNCTION retention_drill.inject_failure()`),
      );
      await expect(drill.reconcileRestore()).rejects.toThrow('injected replay failure');
      await expect(use(restored, (db) => db.query('SELECT 1'))).rejects.toMatchObject({ code: '42501' });
      await use(restoreAdmin, async (db) => {
        expect(await rowsByTable(db, closed)).toEqual(original);
        await db.query('DROP TRIGGER reject_opt_out ON subscribers');
      });
      await drill.reconcileRestore();
      const verify = () =>
        use(restoreAdmin, async (db) => {
          expect(Object.values(await rowsByTable(db, closed)).every((rows) => rows.length === 0)).toBe(true);
          expect((await db.query('SELECT workspace_id FROM retention_drill.erasures')).rows).toEqual([
            { workspace_id: closed },
          ]);
          expect(
            (await db.query('SELECT workspace_id,brand_id,state FROM subscribers ORDER BY state')).rows,
          ).toEqual([
            { workspace_id: active, brand_id: secondBrand, state: 'complained' },
            { workspace_id: active, brand_id: brand, state: 'unsubscribed' },
          ]);
          expect((await db.query('SELECT state FROM subscriber_outbox')).rows).toEqual([
            { state: 'cancelled' },
          ]);
          expect(
            (await db.query("SELECT consumed_at FROM subscriber_confirmation_tokens WHERE action='confirm'"))
              .rows[0]?.consumed_at,
          ).toBeInstanceOf(Date);
          return rowsByTable(db, active);
        });
      const after = await verify();
      await drill.reconcileRestore();
      expect(await verify()).toEqual(after);
      await expect(
        use(restored, (db) => db.query('SELECT * FROM retention_drill.erasures')),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await drill.fixture.stop();
    }
  });
  it('holds unverified closures, complimentary accounts, and schema drift', async () => {
    const drill = await startRetentionDrill();
    try {
      await expect(drill.purge('org_legitimate_customer', deadline)).rejects.toThrow(
        'synthetic retention input',
      );
      await use(drill.fixture.adminUrl, async (db) => {
        await seed(db, closed);
        await db.query('UPDATE sandbox_checkouts SET observed_at=NULL WHERE workspace_id=$1', [closed]);
      });
      await expect(drill.purge(closed, deadline)).resolves.toEqual({ status: 'retained' });
      await use(drill.fixture.adminUrl, async (db) => {
        await db.query("UPDATE sandbox_checkouts SET observed_at=$2::timestamptz + interval '500 microseconds' WHERE workspace_id=$1", [
          closed,
          effectiveEnd,
        ]);
        expect(await verifiedServiceEnd(db,closed,new Date(effectiveEnd))).toEqual(new Date(effectiveEnd));
        await db.query(
          `INSERT INTO workspace_access_events(workspace_id,revision,operation_key,plan,operator_name,reason)
          VALUES($1,3,gen_random_uuid(),'starter','fixture','Restored complimentary access')`,
          [closed],
        );
      });
      await expect(drill.purge(closed, deadline)).resolves.toEqual({ status: 'retained' });
      await use(drill.fixture.adminUrl, (db) =>
        db.query('CREATE TABLE public.unreviewed(workspace_id text NOT NULL)'),
      );
      await expect(drill.purge(closed, deadline)).rejects.toThrow('Review retention coverage');
    } finally {
      await drill.fixture.stop();
    }
  });
});
