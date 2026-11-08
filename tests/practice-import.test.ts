import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { practiceImportDeclaration, practiceImportRows, type ApplyImportResult } from '../src/shared/import-preview.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>;
let db: Database;
const brand = randomUUID(), sibling = randomUUID();
const actor = (workspaceId: string, userId = 'test_owner'): Actor => ({
  workspaceId, userId, actorId: 'user:' + userId, owner: true, kind: 'session', scopes: ['read'], brandIds: null,
});
const one = actor('org_import_one'), other = actor('org_import_other'), bounded = actor('org_import_bounded');
const input = (rows: string[], brandId = brand) => ({
  operationKey: randomUUID(), brandId, emailColumn: 0, declaration: practiceImportDeclaration,
  csvBase64: Buffer.from(['Email', ...rows].join('\n')).toString('base64'),
});
const service = (owner = true) => new CommandService(db,undefined,async () => owner,undefined,undefined,undefined,undefined,undefined,undefined,'test');
const run = (request: ReturnType<typeof input>, user = one, current = service()) =>
  current.execute('audience.applyPracticeImport', request, user) as Promise<ApplyImportResult>;

beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  for (const owner of [one, other, bounded]) {
    await db.tenant(owner.workspaceId, async (sql) => {
      await sql.query('INSERT INTO workspaces(workspace_id,name) VALUES ($1,$2)', [owner.workspaceId, 'Import samples']);
      for (const id of owner === other ? [brand] : [brand, sibling]) {
        await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES ($1,$2,$3)', [owner.workspaceId, id, id === sibling ? 'Second' : 'First']);
      }
    });
  }
  await db.brand(one.workspaceId, brand, async (sql) => {
    for (const state of ['pending','confirmed','unsubscribed','hard_bounced','complained']) {
      await sql.query('INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES ($1,$2,gen_random_uuid(),$3,$4)',
        [one.workspaceId, brand, state+'@sample.test', state]);
    }
  });
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});

describe('owner practice CSV import', () => {
  it('adds only new fictional addresses as pending and returns immutable per-row outcomes', async () => {
    const request = input(['New+reader@SAMPLE.TEST','New+reader@sample.test','invalid','wrong,column',
      'pending@sample.test','confirmed@sample.test','unsubscribed@sample.test','hard_bounced@sample.test',
      'complained@sample.test','foreign@sample.test.invalid','real@example.com']);
    const [initial, concurrent] = await Promise.all([run(request),run(request)]);
    expect(concurrent).toEqual(initial);
    expect(initial.rows.map((row) => [row.row, row.outcome])).toEqual([
      [2,'pending_added'],[3,'duplicate'],[4,'invalid_email'],[5,'column_count'],[6,'kept_pending'],
      [7,'kept_confirmed'],[8,'kept_suppressed'],[9,'kept_suppressed'],[10,'kept_suppressed'],
      [11,'reserved_domain_required'],[12,'reserved_domain_required'],
    ]);
    expect(initial).toMatchObject({ brandId: brand, source: 'practice_csv', declaration: practiceImportDeclaration });
    expect(JSON.stringify(initial)).not.toContain('@');
    const subscriberId = initial.rows[0]!.subscriberId;
    expect(subscriberId).toBeTruthy();
    expect(await service().execute('audience.contact',{brandId:brand,id:subscriberId},one)).toMatchObject({
      practiceImport:{row:2}, contact:{state:'pending'}, events:[],
    });
    await db.brand(one.workspaceId, brand, async (sql) => {
      expect((await sql.query('SELECT id,state,confirmed_at FROM subscribers WHERE email_normalized=$1',['New+reader@sample.test'])).rows)
        .toEqual([{id:subscriberId, state:'pending', confirmed_at:null}]);
      expect((await sql.query('SELECT state FROM subscribers WHERE email_normalized=$1',['unsubscribed@sample.test'])).rows[0]?.state)
        .toBe('unsubscribed');
      expect((await sql.query('SELECT 1 FROM subscribers WHERE right(email_normalized,5)<>$1',['.test'])).rowCount).toBe(0);
      for (const table of ['subscriber_consent_events','subscriber_outbox','subscriber_confirmation_tokens']) {
        expect((await sql.query('SELECT count(*)::int AS count FROM '+table)).rows[0]?.count).toBe(0);
      }
      const receipt = (await sql.query('SELECT actor_id,result FROM operations WHERE operation_key=$1',[request.operationKey])).rows[0];
      expect(receipt).toEqual({actor_id:one.actorId,result:initial});
      await sql.query("UPDATE subscribers SET state='unsubscribed' WHERE id=$1",[subscriberId]);
    });
    expect(await run(request)).toEqual(initial);
    expect((await run({...request, operationKey:randomUUID()})).rows[0]?.outcome).toBe('kept_suppressed');
  });
  it('checks actual owner, environment and brand before returning an old receipt', async () => {
    const request = input(['revoke@sample.test']);
    await run(request);
    await expect(run(request,one,service(false))).rejects.toMatchObject({status:403,code:'owner_required'});
    await expect(run(request,{...one,kind:'connection',scopes:['read','audience:summary'],brandIds:[brand]})).rejects.toMatchObject({status:403});
    await expect(run(request,one,new CommandService(db))).rejects.toMatchObject({status:403,code:'practice_import_disabled'});
    await expect(run({...request,brandId:sibling},other)).rejects.toMatchObject({status:404});
    await expect(run({...request,brandId:sibling})).rejects.toMatchObject({status:409,code:'operation_conflict'});
    await expect(run({...input(['changed@sample.test']), operationKey:request.operationKey})).rejects.toMatchObject({status:409});
    expect((await run(request,other)).rows[0]?.outcome).toBe('pending_added');
    expect((await run(request,actor(one.workspaceId,'other_owner'))).rows[0]?.outcome).toBe('kept_pending');
    expect((await run(input(['revoke@sample.test'],sibling))).rows[0]?.outcome).toBe('pending_added');
  });
  it('bounds the entire workspace even when different brands import at the same time', async () => {
    await db.brand(bounded.workspaceId, sibling, (sql) => sql.query(`INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
      SELECT $1,$2,gen_random_uuid(),'seed'||i||'@example.test','pending' FROM generate_series(1,249) AS i`,[bounded.workspaceId,sibling]));
    const reports = await Promise.all([
      run(input(['first-a@sample.test','first-b@sample.test']),bounded),
      run(input(['second-a@sample.test','second-b@sample.test'],sibling),bounded),
    ]);
    const outcomes = reports.flatMap((report) => report.rows.map((row) => row.outcome));
    expect(outcomes.filter((result) => result==='pending_added')).toHaveLength(1);
    expect(outcomes.filter((result) => result==='contact_limit')).toHaveLength(3);
    const order = reports.find((report) => report.rows[0]?.outcome === 'pending_added');
    expect(order?.rows[1]?.outcome).toBe('contact_limit');
    expect((await run(input(['seed1@example.test'],sibling),bounded)).rows[0]?.outcome).toBe('kept_pending');
  });
  it('requires attestation, valid bytes, a named column and bounded nonempty data before any write', async () => {
    const request = input(['badcsv@sample.test']);
    for (const bad of [
      {...request, declaration:'approve'}, {...request, csvBase64:Buffer.from([0xff]).toString('base64')},
      {...request, emailColumn:1}, input([]), input(Array(practiceImportRows+1).fill('badcsv@sample.test')),
    ]) {
      await expect(service().execute('audience.applyPracticeImport',bad,one)).rejects.toMatchObject({status:422});
    }
    expect((await db.brand(one.workspaceId, brand, (sql) => sql.query('SELECT 1 FROM subscribers WHERE email_normalized=$1',['badcsv@sample.test']))).rowCount).toBe(0);
  });
});
