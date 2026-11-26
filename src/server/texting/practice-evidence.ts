import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rename, mkdir, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireCondition } from '../errors.js';
import { audit, requestHash, type Interface } from './storage.js';
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
// These fixtures contain no business data and have no value as real identity documents.
export function practiceLetter(
  workspace: string,
  brand: string,
  revision: number,
  document: 'CP575' | '147C',
) {
  const ref = requestHash(['practice-ownership-letter-v1', workspace, brand, revision, document]);
  return [
    'FLOCKLETTER STAGING PRACTICE',
    'Fictional ownership letter: ' + document,
    'Enrollment revision: ' + revision,
    'Practice reference: ' + ref,
    'For the simulated enrollment review only. Contains no taxpayer information.',
    '',
  ].join('\n');
}

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
  async attach(
    c: EvidenceCase,
    fixture: string,
    policy: { expires: number | null; hold?: Hold; baseDeadline?: number } = { expires: deletionDue(c) },
  ) {
    await writeFile(await this.path(c), JSON.stringify({ fixture, ...policy }), {
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
    return obj
      ? { hold: obj.hold, expires: obj.expires, baseDeadline: obj.baseDeadline ?? deletionDue(c) }
      : null;
  }
  // Persist only the right to regenerate this *known, identical fictional template*. Every
  // live row version is bound to its database instance and creating transaction. A pg_dump
  // replay obtains a fresh xmin; physical recovery starts a fresh postmaster. A restored
  // authorization cannot silently resurrect a purged exercise original.
  async remember(sql: Sql, brand: string, c: EvidenceCase) {
    const retention = await this.retention(c);
    if (!retention) return;
    const body = {
      brand,
      revision: c.revision,
      document: c.document,
      fingerprint: requestHash(practiceLetter(c.workspace, brand, c.revision, c.document)),
      ...retention,
    };
    await sql.query(
      `INSERT INTO platform_exercise_records(workspace_id,kind,id,body)
      VALUES($1,'hold',$2,$3::jsonb || jsonb_build_object('transaction',pg_current_xact_id()::xid::text,
        'boot',extract(epoch FROM pg_postmaster_start_time())::text))
      ON CONFLICT(workspace_id,kind,id) DO UPDATE SET body=excluded.body`,
      [c.workspace, 'texting-letter/' + c.id, JSON.stringify(body)],
    );
  }
  async recover(sql: Sql, brand: string, c: EvidenceCase, now: Date, materialize = true) {
    if (c.deletedAt) return false;
    const ref = (
      await sql.query<{
        body: {
          brand: string;
          document: string;
          revision: number;
          fingerprint: string;
          expires: number | null;
          baseDeadline: number;
          hold?: Hold;
        };
      }>(
        `SELECT body FROM platform_exercise_records WHERE workspace_id=$1 AND kind='hold' AND id=$2
        AND xmin::text=body->>'transaction' AND body->>'boot'=extract(epoch FROM pg_postmaster_start_time())::text`,
        [c.workspace, 'texting-letter/' + c.id],
      )
    ).rows[0]?.body;
    if (!ref || ref.brand !== brand || ref.document !== c.document || ref.revision !== c.revision)
      return false;
    const fixture = practiceLetter(c.workspace, brand, c.revision, c.document);
    if (ref.fingerprint !== requestHash(fixture) || !Number.isFinite(ref.baseDeadline)) return false;
    const expires = ref.hold ? null : Math.min(ref.baseDeadline, ref.expires ?? 0, deletionDue(c));
    if (expires !== null && expires <= +now) return false;
    if (materialize) {
      const obj = await this.object(c);
      // A copy left by an older web instance must follow the current hold and deadline.
      if (!obj || obj.fixture !== fixture || obj.expires !== expires ||
          (obj.baseDeadline ?? deletionDue(c)) !== ref.baseDeadline ||
          obj.hold?.owner !== ref.hold?.owner || obj.hold?.reason !== ref.hold?.reason ||
          obj.hold?.reviewAt !== ref.hold?.reviewAt) {
        const path = await this.path(c), temp = path + '.' + randomUUID();
        await writeFile(temp, JSON.stringify({fixture, expires, baseDeadline: ref.baseDeadline, hold: ref.hold}),
          { mode: 0o600, flag: 'wx' });
        await rename(temp, path);
      }
    }
    return true;
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
    const current = await store.recover(sql, brand, c, now);
    const policy = await store.retention(c);
    if (current && policy) {
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
    // Keep the minimum receipt in sms_audit; erase the recovery reference and working copy.
    await sql.query(
      "UPDATE platform_exercise_records SET body='{}' WHERE workspace_id=$1 AND kind='hold' AND id=$2",
      [workspace, 'texting-letter/' + c.id],
    );
    await sql.query(
      `UPDATE sms_carrier_brands SET profile=(CASE WHEN profile#>>'{onboarding,evidence,caseId}'=$2
      THEN profile #- '{onboarding,evidence}' ELSE profile END) #- ARRAY['practiceEvidenceCases',$2] WHERE id=$1`,
      [brand, c.id],
    );
    await audit(sql, workspace, 'worker', 'worker', 'onboarding.evidence_deleted', brand, null, {
      caseId: c.id,
      company,
      revision: c.revision,
      document: c.document,
      deletedAt: c.deletedAt,
      reviewer: c.viewedBy ?? c.assigned,
      outcome: c.outcome ?? 'unresolved',
      reason: policy ? 'retention_deadline' : 'original_already_absent',
    });
  }
  return Number.isFinite(next) ? new Date(next) : null;
}
