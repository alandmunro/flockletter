import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { Sql } from '../db.js';
import type { SenderStatus } from '../../shared/sender.js';
import { requireCondition } from '../errors.js';

type Row = { domain: string; challenge: string; checked_at: Date | null; verified_at: Date | null };
export async function senderStatus(sql: Sql): Promise<SenderStatus> {
  const row = (await sql.query<Row>('SELECT domain,challenge,checked_at,verified_at FROM sender_domains'))
    .rows[0];
  return {
    domain: row?.domain ?? null,
    recordName: row ? '_flockletter.' + row.domain : null,
    recordValue: row ? 'flockletter=' + row.challenge : null,
    status: !row ? 'not_configured' : row.verified_at ? 'ownership_verified' : 'awaiting_dns',
    checkedAt: row?.checked_at?.toISOString() ?? null,
    verifiedAt: row?.verified_at?.toISOString() ?? null,
    providerVerified: false,
  };
}
export async function registerSender(sql: Sql, workspace: string, brand: string, domain: string) {
  await sql.query(
    `INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge) VALUES($1,$2,$3,$4)
    ON CONFLICT(workspace_id,brand_id) DO UPDATE SET domain=excluded.domain,challenge=excluded.challenge,checked_at=NULL,verified_at=NULL
    WHERE sender_domains.domain<>excluded.domain`,
    [workspace, brand, domain, randomUUID()],
  );
  return senderStatus(sql);
}
export type LookupTxt = (name: string) => Promise<string[][]>;
export const lookupTxt: LookupTxt = async (name) => {
  const resolver = new Resolver({ timeout: 1200, tries: 1 });
  const timer = setTimeout(() => resolver.cancel(), 3000);
  try {
    return await resolver.resolveTxt(name);
  } finally {
    clearTimeout(timer);
  }
};
export async function verifySender(sql: Sql, lookup: LookupTxt) {
  const before = await senderStatus(sql);
  requireCondition(
    before.recordName && before.recordValue,
    422,
    'sender_missing',
    'Save a brand domain before checking DNS.',
  );
  requireCondition(
    !before.checkedAt || Date.now() - Date.parse(before.checkedAt) >= 60000,
    429,
    'dns_wait',
    'Wait one minute before checking DNS again.',
  );
  let records: string[][] = [];
  try {
    records = await lookup(before.recordName);
  } catch (error) {
    // Absence is a real negative answer. A resolver outage must not confirm ownership.
    if (!['ENODATA', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      await sql.query('UPDATE sender_domains SET checked_at=now(),verified_at=NULL');
      return { ...(await senderStatus(sql)), lookupUnavailable: true };
    }
  }
  const found = records.some((parts) => parts.join('') === before.recordValue);
  await sql.query(
    'UPDATE sender_domains SET checked_at=now(),verified_at=CASE WHEN $1::boolean THEN now() END',
    [found],
  );
  return senderStatus(sql);
}
