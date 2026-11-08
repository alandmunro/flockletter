import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandName } from '../shared/contracts.js';
import type { SupportDirectory, SupportTicket, SupportAutomationStatus } from '../shared/customer-support.js';
import { supportTopics, type SupportTopic } from '../shared/support.js';
import { operationKey, type Api } from './api.js';
import { SupportAutomationSummary } from './SupportAutomationSummary.js';
import { SupportHistory } from './SupportHistory.js';

export function SupportPortal({ api }: { api: Api }) {
  const [directory, setDirectory] = useState<SupportDirectory>();
  const [automation,setAutomation] = useState<SupportAutomationStatus>();
  const [ticket, setTicket] = useState<SupportTicket>();
  const [subject, setSubject] = useState(''),
    [text, setText] = useState('');
  const [topic, setTopic] = useState<SupportTopic>('plans'),
    [replyTo, setReplyTo] = useState('');
  const [draft, setDraft] = useState(''),
    [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const load = useCallback(
    async (offset = 0) => setDirectory(await api.call<SupportDirectory>('support.list', { offset })),
    [api],
  );
  const refreshAutomation=useCallback(async () => setAutomation(await api.call<SupportAutomationStatus>('support.automationStatus',{})),[api]);
  useEffect(() => {
    let active = true;
    void refreshAutomation().catch((e) => {if(active)setError(e.message);});
    api
      .call<SupportDirectory>('support.list', { offset: 0 })
      .then((value) => {
        if (active) setDirectory(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api,refreshAutomation]);
  async function select(id: string) {
    setBusy(true);
    setError('');
    try {
      const result = await api.call<SupportTicket>('support.get', { id });
      setTicket(result);
      setDraft(result.draft ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open this conversation.');
    } finally {
      setBusy(false);
    }
  }
  async function act(name: CommandName) {
    const input =
      name === 'support.create'
        ? { subject, text, topic, ...(replyTo ? { replyTo } : {}) }
        : {
            id: ticket?.id,
            ...(name === 'support.process' ? {} : { expectedVersion: ticket?.version }),
            ...(name === 'support.editDraft' ? { text: draft } : {}),
            ...(name === 'support.approve' ? { reviewCode: ticket?.reviewCode } : {}),
            ...(name === 'support.escalate' ? { reason } : {}),
          };
    const signature = JSON.stringify([name, input]);
    if (pending.current?.signature !== signature) pending.current = { signature, key: operationKey() };
    setBusy(true);
    setError('');
    try {
      const result = await api.call<SupportTicket>(name, { ...input, operationKey: pending.current.key });
      setTicket(result);
      setDraft(result.draft ?? '');
      pending.current = null;
      if (name === 'support.create') {
        setSubject('');
        setText('');
      }
      await load(directory?.offset ?? 0);
      await refreshAutomation();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update this conversation.');
    } finally {
      setBusy(false);
    }
  }
  const capture = directory?.mode === 'capture';
  const reviewable = ticket && ['open', 'review', 'replied', 'escalated'].includes(ticket.state);
  return (
    <section className="card" aria-labelledby="support-title">
      <h2 id="support-title">Support conversations</h2>
      <p>
        Ask about your account, campaigns or audience. Billing disputes, security, privacy and uncertain
        questions go to a human.
      </p>
      {capture && (
        <p>
          <strong>Captured staging exercise.</strong> Replies are saved here without sending email. You can
          exercise the operator review steps below.
        </p>
      )}
      {automation && <SupportAutomationSummary status={automation} busy={busy} onRefresh={() => void refreshAutomation().catch((e) => setError(e.message))} />}
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act('support.create');
        }}
      >
        <h3>New conversation</h3>
        <label htmlFor="support-topic">Topic</label>
        <select
          id="support-topic"
          value={topic}
          onChange={(event) => setTopic(event.target.value as SupportTopic)}
          disabled={busy}
        >
          {supportTopics.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <label htmlFor="support-subject">Subject</label>
        <input
          id="support-subject"
          required
          maxLength={160}
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          disabled={busy}
        />
        <label htmlFor="support-question">How can we help?</label>
        <textarea
          id="support-question"
          required
          maxLength={8000}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={busy}
        />
        <label htmlFor="support-reply-to">Reply email (optional)</label>
        <input
          id="support-reply-to"
          type="email"
          maxLength={254}
          value={replyTo}
          onChange={(event) => setReplyTo(event.target.value)}
          disabled={busy}
        />
        <p>Do not include passwords, payment details or subscriber lists.</p>
        <button className="btn" disabled={busy || !subject.trim() || !text.trim()}>
          Open conversation
        </button>
      </form>
      <h3>Your conversations</h3>
      {!directory && !error && <p role="status">Loading conversations…</p>}
      {directory?.total === 0 && <p>Your support conversations will appear here.</p>}
      <ul>
        {directory?.tickets.map((item) => (
          <li key={item.id}>
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => void select(item.id)}
              aria-pressed={ticket?.id === item.id}
            >
              {item.subject} · {item.state.replaceAll('_', ' ')}
            </button>
          </li>
        ))}
      </ul>
      {directory && (
        <div className="actions">
          <button
            className="btn secondary"
            disabled={busy || directory.offset === 0}
            onClick={() =>
              void load(Math.max(0, directory.offset - directory.limit)).catch((e) => setError(e.message))
            }
          >
            Previous
          </button>
          <button
            className="btn secondary"
            disabled={busy || directory.offset + directory.limit >= directory.total}
            onClick={() => void load(directory.offset + directory.limit).catch((e) => setError(e.message))}
          >
            Next
          </button>
        </div>
      )}
      {ticket && (
        <article className="card" aria-labelledby="support-conversation-title">
          <h3 id="support-conversation-title">{ticket.subject}</h3>
          <p>
            Status: {ticket.state.replaceAll('_', ' ')} ·{' '}
            <button className="btn secondary" disabled={busy} onClick={() => void select(ticket.id)}>
              Refresh conversation
            </button>
          </p>
          <SupportHistory ticket={ticket} />
          {directory?.replyRoutingConfigured && ticket.replyTo && !ticket.replyAddress && <button className="btn secondary" disabled={busy} onClick={() => void act('support.prepareReplyAddress')}>Prepare verified email reply address</button>}
          {ticket.replyAddress && <p>Verified email replies can use <code>{ticket.replyAddress}</code>. This expiring address is specific to this conversation.</p>}
          {capture && ticket.state === 'open' && <button className="btn secondary" disabled={busy} onClick={() => void act('support.exerciseAutomation')}>Exercise automatic reply without sending email</button>}
          {capture && <p>The automatic exercise answers only recognized public-guidance questions. Uncertain questions are handed to a human.</p>}

          {capture && reviewable && (
            <>
              <h4>Review a reply</h4>
              {ticket.state !== 'escalated' && (
                <button className="btn secondary" disabled={busy} onClick={() => void act('support.draft')}>
                  Prepare reply from approved guidance
                </button>
              )}
              <label htmlFor="support-draft">Human-reviewed reply</label>
              <textarea
                id="support-draft"
                value={draft}
                maxLength={4000}
                onChange={(event) => setDraft(event.target.value)}
                disabled={busy}
              />
              <p>
                Draft source: {ticket.draftProvenance?.replaceAll('_', ' ') ?? 'No saved reply'}. Review the
                exact saved reply before approval.
              </p>
              <div className="actions">
                <button
                  className="btn secondary"
                  disabled={busy || !draft.trim()}
                  onClick={() => void act('support.editDraft')}
                >
                  Save human revision
                </button>
                <button
                  className="btn"
                  disabled={busy || ticket.state !== 'review' || !ticket.reviewCode || draft !== ticket.draft}
                  onClick={() => void act('support.approve')}
                >
                  Approve and capture saved reply
                </button>
              </div>
            </>
          )}
          {!capture && ticket.state !== 'closed' && (
            <p>A verified support operator will review your request before sending a reply.</p>
          )}
          {capture &&
            ticket.delivery &&
            ['queued', 'submitting', 'uncertain'].includes(ticket.delivery.state) && (
              <button className="btn secondary" disabled={busy} onClick={() => void act('support.process')}>
                Reconcile reply outcome
              </button>
            )}
          {ticket.state !== 'closed' && (
            <>
              <label htmlFor="support-escalation">Reason for a human handoff</label>
              <input
                id="support-escalation"
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={busy}
              />
              <div className="actions">
                <button
                  className="btn secondary"
                  disabled={busy || !reason.trim()}
                  onClick={() => void act('support.escalate')}
                >
                  Ask a human
                </button>
                <button className="btn secondary" disabled={busy} onClick={() => void act('support.close')}>
                  Close conversation
                </button>
              </div>
            </>
          )}
        </article>
      )}
    </section>
  );
}
