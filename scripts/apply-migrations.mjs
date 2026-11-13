import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import tables from '../src/shared/runtime-tables.json' with {type:'json'};

export async function applyMigrations(client, role) {
  if (!/^flockletter_[a-z0-9_]+$/.test(role)) throw new Error('Use the dedicated Flockletter runtime role.');
  await client.query("SELECT pg_advisory_lock(hashtext('flockletter:migrations'))");
  try {
    for (const name of ['001_foundation.sql', '002_subscriber_intake.sql','003_campaign_rehearsals.sql','004_sender_domains.sql','005_billing_sandbox.sql','006_companies.sql','007_marketing_unsubscribe.sql','008_team_access.sql','009_audience_segments.sql','010_retention_preview.sql','011_checkout_recovery.sql','012_segment_contact_cleanup.sql','013_staging_delivery_worker.sql','014_campaign_feedback.sql','015_private_listmonk.sql','016_customer_billing.sql','017_customer_audience.sql','018_customer_team.sql','019_customer_support_retention.sql','020_customer_delivery.sql','021_customer_scheduler.sql','022_brand_infrastructure.sql','023_provisioning_budget.sql','024_customer_billing_rejoin.sql','025_trial_abuse.sql','026_support_automation.sql','027_retention_operations.sql','028_platform_controls.sql','029_confirmation_feedback.sql','030_customer_worker_heartbeat.sql','031_customer_test_send.sql','032_media_confirmation_choices.sql','033_selectable_delivery.sql','034_brand_signup_design.sql','035_sending_safeguards.sql','036_resend_sender_onboarding.sql','037_trial_status_read_only.sql']) {
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
    await client.query(`GRANT USAGE ON SCHEMA flockletter_customer_jobs TO "${role}"`);
    await client.query(`GRANT EXECUTE ON FUNCTION flockletter_customer_jobs.wake(text,timestamptz),flockletter_customer_jobs.snooze(text,timestamptz),flockletter_customer_jobs.due_scopes(),flockletter_customer_jobs.record_pass(text,text),flockletter_customer_jobs.scope_status(text),flockletter_customer_jobs.claim_provisioning_budget(text,uuid,uuid,integer),flockletter_customer_jobs.worker_heartbeat(text,uuid),flockletter_customer_jobs.worker_stop(text,uuid),flockletter_customer_jobs.worker_liveness(text),flockletter_customer_jobs.bind_resend_domain(text,uuid,uuid,uuid),flockletter_customer_jobs.owned_resend_domain(text,text),flockletter_customer_jobs.claim_resend_domain(text,uuid,uuid,text),flockletter_customer_jobs.register_resend_route(text,uuid,text,jsonb),flockletter_customer_jobs.resend_routes(text),flockletter_customer_jobs.resolve_resend_route(text),flockletter_customer_jobs.sending_status(text),flockletter_customer_jobs.sending_admit(text,uuid),flockletter_customer_jobs.sending_cooldown(text,uuid,integer),flockletter_customer_jobs.sending_outcome(text,uuid,text),flockletter_customer_jobs.sending_usage(integer,integer,timestamptz,integer,integer,timestamptz,timestamptz) TO "${role}"`);
    await client.query(`GRANT EXECUTE ON FUNCTION public.flockletter_restore_blocked(),public.flockletter_retention_blocked(text),public.flockletter_platform_hold(text),flockletter_customer_jobs.trial_claim(text,text,text,text,integer,integer,text,uuid,text,text,text),flockletter_customer_jobs.register_support_reply_route(text,uuid,text,text,timestamptz),flockletter_customer_jobs.resolve_support_reply_route(text),flockletter_customer_jobs.register_confirmation_route(text,uuid,uuid,text,text,timestamptz),flockletter_customer_jobs.resolve_confirmation_route(text) TO "${role}"`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('flockletter:migrations'))");
  }
}
