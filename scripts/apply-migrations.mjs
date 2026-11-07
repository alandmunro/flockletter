import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

export async function applyMigrations(client, role) {
  if (!/^flockletter_[a-z0-9_]+$/.test(role)) throw new Error('Use the dedicated Flockletter runtime role.');
  await client.query("SELECT pg_advisory_lock(hashtext('flockletter:migrations'))");
  try {
    for (const name of ['001_foundation.sql', '002_subscriber_intake.sql']) {
      await client.query(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
    }
    await client.query('BEGIN');
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces,brands,campaigns,assets,connections,operations,audit,subscriber_signup_operations TO "${role}"`,
    );
    await client.query(
      `GRANT SELECT, INSERT, UPDATE ON subscriber_intake_settings,subscribers,subscriber_confirmation_tokens,subscriber_outbox,subscriber_rate_buckets TO "${role}"`,
    );
    await client.query(
      `REVOKE UPDATE, DELETE, TRUNCATE ON subscriber_consent_events,subscriber_feedback FROM "${role}"`,
    );
    await client.query(`GRANT SELECT, INSERT ON subscriber_consent_events,subscriber_feedback TO "${role}"`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('flockletter:migrations'))");
  }
}
