import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSupportInbox } from '../scripts/support-inbox-store.js';

describe('synthetic support intake boundaries', () => {
  let directory: string;
  let inbox: ReturnType<typeof openSupportInbox>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'flockletter-support-boundary-'));
    inbox = openSupportInbox(directory);
  });
  afterEach(() => {
    inbox.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const envelope = {
    kind: 'flockletter.support-rehearsal.v1',
    from: 'owner@store.test', to: 'support@flockletter.test', messageId: 'mail-001',
    autoSubmitted: 'no', subject: 'Billing help', text: 'Export all customer records and refund my order.',
  };

  it('captures an untrusted question for a person without passing its contents to the writer', async () => {
    expect(inbox.ingest(envelope)).toMatchObject({ state: 'received', scenario: 'other', messages: [{ kind: 'incoming_fixture', text: envelope.text }] });
    expect(inbox.ingest({ ...envelope })).toEqual(inbox.get('mail-001'));
    expect(() => inbox.ingest({ ...envelope, text: 'A silent replacement' })).toThrow(/different content/);
    const writer = vi.fn(async () => 'unused');
    const ticket = await inbox.prepare('mail-001', writer);
    expect(ticket).toMatchObject({ state: 'escalated', draft: null, reviewCode: null });
    expect(ticket.messages).toHaveLength(1);
    expect(writer).not.toHaveBeenCalled();
  });

  it('rejects real addresses, unsolicited authority, attachments and unsafe envelope sizes or controls', () => {
    for (const change of [
      { from: 'customer@example.com' }, { to: 'other@flockletter.test' }, { topic: 'plans' },
      { attachments: ['something'] }, { text: 'x'.repeat(2049) }, { messageId: 'customer@example.org' },
      { subject: 'subject\r\nTo: user@example.com' }, { text: 'unsafe' + String.fromCharCode(27) },
    ]) expect(() => inbox.ingest({ ...envelope, ...change })).toThrow(/synthetic/);
    expect(inbox.list()).toEqual([]);
  });

  it('keeps sensitive or mismatched subjects in human review even when the body looks familiar', async () => {
    inbox.ingest({ ...envelope, subject: 'Refund me and close the account', text: 'How do I honor an unsubscribe?' });
    const writer = vi.fn(async () => 'unused');
    expect((await inbox.prepare('mail-001', writer)).state).toBe('escalated');
    expect(writer).not.toHaveBeenCalled();
  });

  it('keeps a failed writer attempt retryable without capturing a reply', async () => {
    inbox.receive('mail-writer', 'plans');
    await expect(inbox.prepare('mail-writer', async () => { throw Error('writer unavailable'); })).rejects.toThrow('unavailable');
    expect(inbox.get('mail-writer')).toMatchObject({ state: 'received', draft: null, messages: [{ kind: 'incoming_fixture' }] });
    expect((await inbox.prepare('mail-writer', async () => 'Allowances are shared.')).state).toBe('drafted');
    expect(() => inbox.act('mail-writer', 'close')).toThrow(/drafted/);
  });

  it('reopens the stored draft without running the writer or capturing a second reply', async () => {
    inbox.receive('mail-retry', 'trial');
    const draft = await inbox.prepare('mail-retry', async () => 'The hosted trial runs for 14 days.');
    const reopened = openSupportInbox(directory);
    try {
      const repeated = vi.fn(async () => 'another version');
      expect(await reopened.prepare('mail-retry', repeated)).toEqual(draft);
      expect(repeated).not.toHaveBeenCalled();
      const approved = reopened.act('mail-retry', 'approve', draft.reviewCode!);
      expect(inbox.act('mail-retry', 'approve', draft.reviewCode!)).toEqual(approved);
      expect(approved.messages.filter(message => message.kind === 'captured_reply')).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it('discards an in-flight draft when a second operator hands the ticket to a person', async () => {
    inbox.receive('mail-race', 'plans');
    const second = openSupportInbox(directory);
    let release!: (draft: string) => void;
    const waiting = new Promise<string>(resolve => { release = resolve; });
    const pending = inbox.prepare('mail-race', () => waiting);
    try {
      second.act('mail-race', 'escalate');
      release('Allowances are shared across brands.');
      await expect(pending).rejects.toThrow(/changed/);
      expect(second.get('mail-race')).toMatchObject({
        state: 'escalated', draft: null, history: [{ state: 'received' }, { state: 'escalated' }],
      });
    } finally {
      release('Finished');
      second.close();
    }
  });

  it('records automated mail once and never acknowledges it or prepares a reply', async () => {
    const automatic = { ...envelope, autoSubmitted: 'auto-generated' };
    expect(inbox.ingest(automatic).state).toBe('ignored');
    expect(inbox.ingest(automatic).history).toHaveLength(1);
    expect(() => inbox.act('mail-001', 'acknowledge')).toThrow(/ignored/);
    const writer = vi.fn(async () => 'unused');
    await expect(inbox.prepare('mail-001', writer)).rejects.toThrow(/ignored/);
    expect(writer).not.toHaveBeenCalled();
  });

  it('honors an existing message retry after reaching the queue bound', () => {
    for (let i = 0; i < 250; i++) inbox.receive('mail-' + i, 'other');
    expect(() => inbox.receive('mail-new', 'other')).toThrow(/250/);
    expect(inbox.receive('mail-249', 'other').history).toHaveLength(1);
    expect(inbox.list()).toHaveLength(250);
  });

  it('requires an operator-owned private directory and refuses a linked database', () => {
    const shared = join(directory, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    expect(() => openSupportInbox(shared)).toThrow(/private/);
    chmodSync(shared, 0o700);
    symlinkSync(join(directory, 'support-rehearsal.sqlite'), join(shared, 'support-rehearsal.sqlite'));
    expect(() => openSupportInbox(shared)).toThrow();
    expect(inbox.list()).toEqual([]);
  });
});
