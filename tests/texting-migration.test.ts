import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { startDatabase } from '../scripts/database-fixture.js';
import { verifyRuntimeBoundary } from '../src/server/runtime-boundary.mjs';

let fixture: Awaited<ReturnType<typeof startDatabase>>;
beforeAll(async () => { fixture = await startDatabase(); });
afterAll(async () => { await fixture?.stop(); });

describe('040_texting migration (CHG-3)', () => {
  it('keeps the runtime boundary, seeds only public defaults, and rolls back and reapplies cleanly', async () => {
    const runtime = new pg.Client({ connectionString: fixture.url });
    await runtime.connect();
    try {
      await verifyRuntimeBoundary(runtime);
      const setting = async (key: string) => (await runtime.query('SELECT flockletter_customer_jobs.texting_setting($1,$2) v', ['org_any', key])).rows[0].v;
      expect(await setting('contact_monthly_limit')).toBe(4);
      expect(await setting('send_window_start_hour')).toBe(9);
      for (const fraud of ['carrier_daily_limit', 'monthly_segment_allowance', 'test_texts_per_day', 'live_recipient_allow_list'])
        expect(await setting(fraud)).toBeNull();
      // The runtime role cannot read private texting tables directly.
      await expect(runtime.query('SELECT * FROM flockletter_customer_jobs.texting_accounts')).rejects.toThrow();
      await expect(runtime.query('SELECT * FROM flockletter_customer_jobs.texting_settings')).rejects.toThrow();
    } finally { await runtime.end(); }
    const admin = new pg.Client({ connectionString: fixture.adminUrl });
    await admin.connect();
    try {
      await admin.query(await readFile('migrations/rollback/040_texting.down.sql', 'utf8'));
      expect((await admin.query("SELECT to_regclass('public.sms_messages') r")).rows[0].r).toBeNull();
      expect((await admin.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='team_grants' AND column_name='sms_send'")).rows[0].n).toBe(0);
      await admin.query(await readFile('migrations/040_texting.sql', 'utf8'));
      // Reapplying twice is a no-op (IF NOT EXISTS everywhere, defaults not duplicated).
      await admin.query(await readFile('migrations/040_texting.sql', 'utf8'));
      expect((await admin.query("SELECT count(*)::int n FROM flockletter_customer_jobs.texting_settings WHERE key='contact_monthly_limit'")).rows[0].n).toBe(1);
    } finally { await admin.end(); }
  });
});
