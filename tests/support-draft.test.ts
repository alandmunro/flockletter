import { describe, expect, it, vi } from 'vitest';
import { supportDraft } from '../src/server/support-draft.js';
describe('operator support drafts', () => {
  it('sends only approved public product facts to the writer and requires human review', async () => {
    const rewrite = vi.fn(async (_facts: string) => 'Prepare your draft in Campaigns.');
    expect(await supportDraft('campaigns', rewrite)).toMatchObject({ kind: 'draft', automaticSend: false, draft: expect.stringContaining('This reply was drafted with AI assistance.') });
    expect(rewrite).toHaveBeenCalledTimes(1);
    const facts = rewrite.mock.calls[0]?.[0];
    expect(facts).toContain('Open captured email');
    expect(facts).toContain('Private Listmonk test stays inside Flockletter');
    expect(facts).toContain('only to AWS-owned simulator mailboxes');
    expect(facts).toContain('Approving Amazon SES mailbox simulator or Listmonk with Amazon SES simulator');
  });
  it('routes security, recovery, privacy, billing and unknown topics to a human without a model call', async () => {
    const rewrite = vi.fn(async (_facts: string) => 'unused');
    for (const topic of ['security', 'recovery', 'privacy', 'billing', 'other'] as const)
      expect(await supportDraft(topic, rewrite)).toMatchObject({
        kind: 'human_review',
        draft: null,
        automaticSend: false,
      });
    expect(rewrite).not.toHaveBeenCalled();
  });
  it('rejects unbounded or reasoning output instead of presenting it as a reply', async () => {
    await expect(supportDraft('plans', async () => '<think>hidden</think>')).rejects.toThrow();
    await expect(supportDraft('audience', async () => 'x'.repeat(2510))).rejects.toThrow();
    await expect(supportDraft('audience', async () => 'Unsafe' + String.fromCharCode(27) + 'control')).rejects.toThrow();
    await expect(supportDraft('audience', async () => 'Unsafe' + String.fromCodePoint(0x202e) + 'direction')).rejects.toThrow();
  });
});
