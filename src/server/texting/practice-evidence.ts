import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rename, mkdir, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireCondition } from '../errors.js';
import { audit, type Interface } from './storage.js';
import type { Sql } from '../db.js';

const day = 86_400_000;
type Hold = {
  reason: 'carrier_appeal' | 'legal_hold';
  owner: string;
  reviewAt: string;
};
export type EvidenceCase = {
  id: string;
  workspace: string;
  revision: number;
  document: 'CP575' | '147C';
  uploadedAt: string;
  assigned: string | null;
  closedAt?: string;
  outcome?: 'accepted' | 'correction';
  deletedAt?: string;
  hold?: Hold;
  viewedBy?: string;
  viewedAt?: string;
};
export type EvidenceActor = { userId: string; mfaAt?: string; via: Interface };
export function deletionDue(c: EvidenceCase) {
  return Math.min(
    Date.parse(c.uploadedAt) + 30 * day,
    c.closedAt ? Date.parse(c.closedAt) + 7 * day : Infinity,
  );
}
export function reviewerSeats(raw?: string): string[] {
  if (!raw) return [];
  const seats = raw.split(',').map((id) => id.trim());
  if (
    seats.length > 2 ||
    new Set(seats).size !== seats.length ||
    seats.some((id) => !/^user_[a-zA-Z0-9_-]{1,100}$/.test(id))
  )
    throw Error('Configure unique named evidence reviewers by their verified user IDs.');
  return seats;
}

// Only the exact company-bound synthetic fixture reaches this store. Originals are outside the
// database and its backups. A restored receipt can never recreate an uploaded original.
export class PracticeEvidence {
  private directory?: Promise<string>;
  constructor(
    readonly seats: readonly string[],
    private readonly root?: string,
  ) {}
  private dir() {
    return (this.directory ??= this.openDirectory());
  }
  private async openDirectory() {
    if (!this.root) return mkdtemp(join(tmpdir(), 'flockletter-practice-'));
    await mkdir(this.root, { mode: 0o700, recursive: true });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw Error('Practice letter storage is unavailable.');
    return this.root;
  }
  private async bucket(workspace: string) {
    const path = join(await this.dir(), createHash('sha256').update(workspace).digest('hex'));
    await mkdir(path, { mode: 0o700, recursive: true });
    return path;
  }
  private async path(c: Pick<EvidenceCase, 'id' | 'workspace'>) {
    if (!/^[0-9a-f-]{36}$/.test(c.id)) throw Error('Invalid practice receipt.');
    return join(await this.bucket(c.workspace), c.id);
  }
  async attach(c: EvidenceCase, fixture: string) {
    await writeFile(await this.path(c), JSON.stringify({ fixture, expires: deletionDue(c) }), {
      mode: 0o600,
      flag: 'wx',
    });
  }
  private async object(
    c: EvidenceCase,
  ): Promise<{ fixture: string; expires: number | null; hold?: Hold; baseDeadline?: number } | null> {
    try {
      return JSON.parse(await readFile(await this.path(c), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async available(c: EvidenceCase, now: Date) {
    if (c.deletedAt) return false;
    const obj = await this.object(c);
    return !!obj && (obj.expires === null || Math.min(obj.expires, deletionDue(c)) > +now);
  }
  // Store the deadline alongside the original as well: restoring an older SQL snapshot must
  // not extend a closed case's lifetime. Only an explicit hold may extend it.
  async schedule(c: EvidenceCase, now: Date, change: 'close' | 'hold' | 'release_hold' = 'close') {
    const obj = await this.object(c);
    if (!obj || (obj.expires !== null && obj.expires <= +now)) return;
    const baseDeadline = Math.min(deletionDue(c), obj.baseDeadline ?? obj.expires ?? Infinity);
    const hold = change === 'hold' ? c.hold : change === 'release_hold' ? undefined : obj.hold;
    const next = hold ? null : baseDeadline;
    const path = await this.path(c),
      temp = path + '.' + randomUUID();
    await writeFile(temp, JSON.stringify({ fixture: obj.fixture, expires: next, baseDeadline, hold }), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temp, path);
  }
  async read(c: EvidenceCase, now: Date) {
    const obj = await this.object(c);
    requireCondition(
      !c.deletedAt && obj && (obj.expires === null || Math.min(obj.expires, deletionDue(c)) > +now),
      410,
      'evidence_expired',
      'This practice original is unavailable. An open review can request a fresh upload.',
    );
    return obj.fixture;
  }
  async retention(c: EvidenceCase) {
    const obj = await this.object(c);
    return obj ? { hold: obj.hold, expires: obj.expires } : null;
  }
  async remove(c: EvidenceCase) {
    await unlink(await this.path(c)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  // Called under the same workspace lock as upload and hold changes. This also removes
  // abandoned writes and files whose receipts disappeared during a database restore.
  async reconcileCopies(workspace: string, retained: Set<string>) {
    const bucket = join(await this.dir(), createHash('sha256').update(workspace).digest('hex'));
    let files: string[];
    try {
      files = await readdir(bucket);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const file of files) {
      if (/^[0-9a-f-]{36}(?:\.[0-9a-f-]{36})?$/.test(file) && !retained.has(file)) {
        // Keep a held original through restoration of a snapshot predating its case receipt.
        if (file.length === 36) {
          const obj = JSON.parse(await readFile(join(bucket, file), 'utf8')) as { hold?: Hold };
          if (obj.hold) continue;
        }
        await unlink(join(bucket, file));
      }
    }
  }
  authorize(actor: EvidenceActor, c: EvidenceCase, now: Date, takeOver = false) {
    const verified = Date.parse(actor.mfaAt ?? '');
    requireCondition(
      this.seats.includes(actor.userId),
      403,
      'evidence_reviewer_required',
      'A named identity reviewer is required.',
    );
    requireCondition(
      verified <= +now && +now - verified < 300_000,
      403,
      'operator_mfa_required',
      'Verify both sign-in factors to review this case.',
    );
    requireCondition(
      takeOver || c.assigned === actor.userId,
      403,
      'evidence_assignment_required',
      'Claim this exact case before opening its letter.',
    );
  }
}

export async function saveEvidenceCase(sql: Sql, brand: string, c: EvidenceCase) {
  await sql.query(
    `UPDATE sms_carrier_brands SET profile=jsonb_set(profile,'{practiceEvidenceCases}',
    coalesce(profile->'practiceEvidenceCases','{}') || jsonb_build_object($2::text,$3::jsonb)) WHERE id=$1`,
    [brand, c.id, JSON.stringify(c)],
  );
}
export async function sweepEvidence(sql: Sql, workspace: string, store: PracticeEvidence, now: Date) {
  const rows = (
    await sql.query<{
      brand: string;
      company: string;
      c: EvidenceCase;
    }>(`SELECT id brand,company_id company,c.value c
    FROM sms_carrier_brands CROSS JOIN LATERAL jsonb_each(profile->'practiceEvidenceCases') c WHERE NOT c.value ? 'deletedAt'`)
  ).rows;
  await store.reconcileCopies(workspace, new Set(rows.map((row) => row.c.id)));
  let next = Infinity;
  for (const { brand, company, c } of rows) {
    const policy = await store.retention(c);
    if (policy && (policy.expires === null || Math.min(policy.expires, deletionDue(c)) > +now)) {
      if (JSON.stringify(policy.hold) !== JSON.stringify(c.hold)) {
        if (policy.hold) c.hold = policy.hold;
        else delete c.hold;
        await saveEvidenceCase(sql, brand, c);
      }
      if (policy.expires !== null) next = Math.min(next, policy.expires, deletionDue(c));
      continue;
    }
    await store.remove(c);
    c.deletedAt = now.toISOString();
    await saveEvidenceCase(sql, brand, c);
    await audit(sql, workspace, 'worker', 'worker', 'onboarding.evidence_deleted', brand, null, {
      caseId: c.id,
      company,
      revision: c.revision,
      document: c.document,
      deletedAt: c.deletedAt,
      outcome: c.outcome ?? 'unresolved',
      reason: policy ? 'retention_deadline' : 'original_already_absent',
    });
  }
  return Number.isFinite(next) ? new Date(next) : null;
}
