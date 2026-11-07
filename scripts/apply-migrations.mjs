import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import tables from '../src/shared/runtime-tables.json' with {type:'json'};

export async function applyMigrations(client, role) {
  if (!/^flockletter_[a-z0-9_]+$/.test(role)) throw new Error('Use the dedicated Flockletter runtime role.');
  await client.query("SELECT pg_advisory_lock(hashtext('flockletter:migrations'))");
  try {
    for (const name of ['001_foundation.sql', '002_subscriber_intake.sql','003_campaign_rehearsals.sql','004_sender_domains.sql','005_billing_sandbox.sql','006_companies.sql','007_marketing_unsubscribe.sql','008_team_access.sql','009_audience_segments.sql','010_retention_preview.sql','011_checkout_recovery.sql','012_segment_contact_cleanup.sql']) {
      await client.query(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
    }
    await client.query('BEGIN');
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    const names = tables.map(table => table.name);
    // Remove drift from earlier releases, including grants on individual columns.
    const columns = await client.query(`
      SELECT format('REVOKE %s (%I) ON public.%I FROM %s',
        acl.privilege_type, a.attname, c.relname, CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE quote_ident($2::text) END) AS revoke
      FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
      CROSS JOIN LATERAL aclexplode(a.attacl) acl
      WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped
        AND acl.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname=$2))`, [names,role]);
    for (const {revoke} of columns.rows) await client.query(revoke);
    const qualified = list => list.map(name=>'public."'+name+'"').join(', ');
    await client.query(`REVOKE ALL PRIVILEGES ON ${qualified(names)} FROM "${role}", PUBLIC`);
    const groups=new Map();
    for (const {name,permissions} of tables) {
      const allowed = permissions.join(', ');
      if (!groups.has(allowed)) groups.set(allowed,[]);
      groups.get(allowed).push(name);
    }
    for (const [allowed,group] of groups)
      await client.query(`GRANT ${allowed} ON ${qualified(group)} TO "${role}"`);
    await client.query(`GRANT EXECUTE ON FUNCTION public.flockletter_default_company_id(text) TO "${role}"`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('flockletter:migrations'))");
  }
}
