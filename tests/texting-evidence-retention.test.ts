import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import {
  PracticeEvidence,
  reviewerSeats,
  type EvidenceCase,
} from '../src/server/texting/practice-evidence.js';

it('enforces the earlier of the upload or closure deadline, including after a restart and a restored receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flock-evidence-test-'));
  const store = new PracticeEvidence([], directory),
    day = 86400000,
    start = Date.UTC(2036, 0, 1);
  try {
    for (const closedDay of [2, 28]) {
      const c: EvidenceCase = {
        id: randomUUID(),
        workspace: 'org_mock',
        revision: 1,
        document: '147C',
        assigned: null,
        uploadedAt: new Date(start).toISOString(),
      };
      const old = { ...c };
      await store.attach(c, 'Fictional original.');
      c.closedAt = new Date(start + closedDay * day).toISOString();
      await store.schedule(c, new Date(c.closedAt));
      const restored = new PracticeEvidence([], directory);
      const expiry = start + Math.min(30, closedDay + 7) * day;
      expect(await restored.read(old, new Date(expiry - 1))).toBe('Fictional original.');
      await expect(restored.read(old, new Date(expiry))).rejects.toMatchObject({
        code: 'evidence_expired',
      });
      await restored.reconcileCopies(c.workspace, new Set());
      expect(await store.available(c, new Date(start))).toBe(false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('requires unique named reviewer seats and fresh multifactor proof', () => {
  expect(reviewerSeats()).toEqual([]);
  expect(() => reviewerSeats('user_a,user_a')).toThrow();
  expect(() => reviewerSeats('user_a,user_b,user_c')).toThrow();
  const store = new PracticeEvidence(reviewerSeats('user_a,user_b'));
  const now = new Date(),
    c: EvidenceCase = {
      id: randomUUID(),
      workspace: 'org_mock',
      uploadedAt: now.toISOString(),
      revision: 1,
      document: 'CP575',
      assigned: 'user_a',
    };
  for (const mfaAt of [undefined, new Date(+now - 300_000).toISOString(), new Date(+now + 1).toISOString()]) {
    expect(() => store.authorize({ userId: 'user_a', via: 'operator_ui', mfaAt }, c, now)).toThrow();
  }
  expect(() =>
    store.authorize({ userId: 'user_a', via: 'operator_ui', mfaAt: now.toISOString() }, c, now),
  ).not.toThrow();
});
