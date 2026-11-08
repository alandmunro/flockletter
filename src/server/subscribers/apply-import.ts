import { plans } from '../../shared/contracts.js';
import { practiceImportRows, type ApplyImportInput, type ApplyImportResult, type ApplyOutcome } from '../../shared/import-preview.js';
import type { SubscriberState } from '../../shared/audience.js';
import { hostedTrial } from '../../shared/trial.js';
import { workspaceAccess } from '../campaign/access.js';
import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { importRows } from './import-preview.js';

type StoredAddress = { email_normalized: string; state: SubscriberState };

// All command mutations hold the workspace lock. Count stored rows conservatively
// across its brands, under each brand's existing RLS policy, without reading addresses.
async function remainingPracticeStorage(sql: Sql, selectedBrand: string) {
  const access = await workspaceAccess(sql);
  const maximum = plans.find((plan) => plan.id === access.plan)?.contacts ?? hostedTrial.activeContacts;
  const brands = (await sql.query<{ id: string }>('SELECT id FROM brands ORDER BY id')).rows;
  let remaining: number = maximum;
  for (const brand of brands) {
    if (!remaining) break;
    await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand.id]);
    const result = await sql.query<{ used: number }>(
      'SELECT count(*)::int AS used FROM (SELECT 1 FROM subscribers WHERE brand_id=$1 LIMIT $2) AS bounded',
      [brand.id, remaining],
    );
    remaining -= result.rows[0]!.used;
  }
  await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [selectedBrand]);
  return remaining;
}

async function storedAddresses(sql: Sql, brandId: string, addresses: string[]) {
  const { rows } = await sql.query<StoredAddress>(
    'SELECT email_normalized,state FROM subscribers WHERE brand_id=$1 AND email_normalized=ANY($2::text[])',
    [brandId, addresses],
  );
  return new Map(rows.map((row) => [row.email_normalized, row.state]));
}

function retained(state: SubscriberState): ApplyOutcome {
  if (state === 'confirmed') return 'kept_confirmed';
  if (state === 'pending') return 'kept_pending';
  return 'kept_suppressed';
}

export async function applyPracticeImport(sql: Sql, workspace: string, input: ApplyImportInput): Promise<ApplyImportResult> {
  const parsed = importRows(input);
  requireCondition(parsed.length > 0 && parsed.length <= practiceImportRows, 422, 'practice_row_limit',
    `Choose a file with 1 to ${practiceImportRows} data rows for a practice import.`);
  const eligible = parsed.flatMap((row) => 'address' in row && row.address.endsWith('.test') ? [row.address] : []);
  const existing = await storedAddresses(sql, input.brandId, eligible);
  const missing = eligible.filter((address) => !existing.has(address));
  const additions = missing.length ? missing.slice(0, await remainingPracticeStorage(sql, input.brandId)) : [];
  const inserted = new Map<string, string>();
  if (additions.length) {
    const result = await sql.query<{ email_normalized: string; id: string }>(`
      INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
      SELECT $1,$2,gen_random_uuid(),address,'pending' FROM unnest($3::text[]) AS incoming(address)
      ON CONFLICT(workspace_id,brand_id,email_normalized) DO NOTHING RETURNING email_normalized,id`,
      [workspace, input.brandId, additions]);
    for (const row of result.rows) inserted.set(row.email_normalized, row.id);
    // A simultaneous signup can win the unique constraint. Preserve and report its state.
    const conflicts = additions.filter((address) => !inserted.has(address));
    if (conflicts.length) {
      for (const [address, state] of await storedAddresses(sql, input.brandId, conflicts)) existing.set(address, state);
    }
  }
  // The command receipt is the owner's import evidence. Never record an import as subscriber consent.
  return {
    source: 'practice_csv', brandId: input.brandId, declaration: input.declaration,
    rows: parsed.map((item) => {
      if ('issue' in item) return { row: item.row, outcome: item.issue };
      const address = item.address;
      if (!address.endsWith('.test')) return { row: item.row, outcome: 'reserved_domain_required' };
      const subscriberId = inserted.get(address);
      if (subscriberId) return { row: item.row, outcome: 'pending_added', subscriberId };
      const state = existing.get(address);
      return { row: item.row, outcome: state ? retained(state) : 'contact_limit' };
    }),
  };
}
