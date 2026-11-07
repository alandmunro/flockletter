import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Database } from '../dist/server/server/db.js';
import { CommandService } from '../dist/server/server/service.js';

const cases = [
  { workspace: 'org_selfhost_drill_north', brandName: 'North fixture', sample: 'north@example.test' },
  { workspace: 'org_selfhost_drill_south', brandName: 'South fixture', sample: 'south@example.test' },
];
function owner(workspace) {
  return {
    workspaceId: workspace,
    userId: 'selfhost_fixture',
    actorId: 'user:selfhost_fixture',
    kind: 'session',
    owner: true,
    brandIds: null,
    scopes: ['read'],
  };
}
async function marker(db, name) {
  const row = (
    await db.pool.query(
      "SELECT current_database() AS name,current_user AS role,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
    )
  ).rows[0];
  assert.equal(row.name, name);
  assert.equal(row.role, 'flockletter_runtime');
  assert.equal(row.marker, 'Flockletter disposable restore fixture');
  await db.verifyBoundary();
}
async function brandFor(service, sample) {
  const workspace = await service.execute('workspace.get', {}, owner(sample.workspace));
  assert.equal(workspace.brands.length, 1);
  return workspace.brands[0].id;
}
async function seed(db) {
  const service = new CommandService(db);
  for (const sample of cases) {
    await service.execute(
      'workspace.initialize',
      { name: sample.brandName, brandName: sample.brandName, operationKey: randomUUID() },
      owner(sample.workspace),
    );
    const brand = await brandFor(service, sample);
    await db.brand(sample.workspace, brand, async (sql) => {
      const exists = await sql.query('SELECT id FROM subscribers LIMIT 1');
      assert.equal(exists.rowCount, 0, 'Use a fresh disposable database for every drill.');
      for (const address of [sample.sample, 'shared@example.test']) {
        const id = randomUUID();
        await sql.query(
          "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state,confirmed_at) VALUES($1,$2,$3,$4,'confirmed',now())",
          [sample.workspace, brand, id, address],
        );
        for (const ev of ['signup_requested', 'confirmed']) {
          await sql.query(
            "INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain) VALUES($1,$2,$3,$4,$5,'brand_marketing','drill-v1',$6,'selfhost-fixture','example.test')",
            [
              sample.workspace,
              brand,
              randomUUID(),
              id,
              ev,
              createHash('sha256').update('Synthetic consent fixture.').digest('hex'),
            ],
          );
        }
      }
    });
  }
  await stopOne(db, cases[0], cases[0].sample);
}
async function stopOne(db, sample, address) {
  const service = new CommandService(db),
    brand = await brandFor(service, sample);
  const id = await db.brand(
    sample.workspace,
    brand,
    async (sql) =>
      (await sql.query('SELECT id FROM subscribers WHERE email_normalized=$1', [address])).rows[0].id,
  );
  await service.execute('audience.unsubscribe', { brandId: brand, id }, owner(sample.workspace));
}
async function picture(db) {
  const service = new CommandService(db),
    data = [];
  const brands = [];
  for (const sample of cases) brands.push(await brandFor(service, sample));
  for (const [i, sample] of cases.entries()) {
    const brand = brands[i];
    const facts = await db.brand(sample.workspace, brand, async (sql) => {
      const contacts = (
        await sql.query('SELECT id,email_normalized,state,confirmed_at FROM subscribers ORDER BY id')
      ).rows;
      const events = (
        await sql.query(
          'SELECT id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain,recorded_at FROM subscriber_consent_events ORDER BY id',
        )
      ).rows;
      const jobs = (await sql.query('SELECT id FROM subscriber_outbox')).rowCount;
      assert.equal(contacts.length, 2);
      assert.equal(jobs, 0);
      assert.ok(events.length >= 4);
      if (i === 0)
        assert.ok(contacts.some((c) => c.email_normalized === sample.sample && c.state === 'unsubscribed'));
      else assert.ok(contacts.every((c) => c.state === 'confirmed'));
      return { contacts, events };
    });
    const none = await db.brand(
      sample.workspace,
      brands[1 - i],
      async (sql) => (await sql.query('SELECT id FROM subscribers')).rowCount,
    );
    assert.equal(none, 0, 'Foreign brand context must expose zero contacts.');
    await assert.rejects(
      db.brand(sample.workspace, brand, (sql) =>
        sql.query(
          "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'forbidden@example.test','pending')",
          [cases[1 - i].workspace, brands[1 - i], randomUUID()],
        ),
      ),
      { code: '42501' },
    );
    data.push({ brand, facts });
  }
  assert.equal((await db.pool.query('SELECT id FROM subscribers')).rowCount, 0);
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export async function drill(action, sourceUrl, restoreUrl) {
  const source = new Database(sourceUrl),
    target = new Database(restoreUrl);
  try {
    await marker(source, 'flockletter_demo');
    if (action === 'seed') {
      await seed(source);
      console.log('Two synthetic workspaces and their consent histories are ready.');
      return;
    }
    if (action === 'advance') {
      await stopOne(source, cases[0], 'shared@example.test');
      console.log('Recorded a post-backup opt-out in the disposable source.');
      return;
    }
    await marker(target, 'flockletter_restore');
    const original = await picture(source),
      restored = await picture(target);
    if (original !== restored) {
      const error = new Error('Restored consent is stale.');
      error.code = 'RESTORE_STALE';
      throw error;
    }
    console.log(
      'Restore matched both synthetic workspaces, all consent history and current suppressions; foreign reads and writes were denied. No message jobs existed.',
    );
  } finally {
    await source.close();
    await target.close();
  }
}
