import type { SupportTicket } from '../shared/customer-support.js';

const kindLabel: Record<SupportTicket['messages'][number]['kind'], string> = {
  incoming: 'Your message',
  draft: 'Saved draft',
  captured_reply: 'Captured reply',
  sent_reply: 'Support reply',
};

export function SupportHistory({ ticket }: { ticket: SupportTicket }) {
  return (
    <>
      <ol className="support-history" aria-label={`Messages for ${ticket.subject}`}>
        {ticket.messages.length === 0 && <li>No messages yet.</li>}
        {ticket.messages.map((m) => (
          <li key={m.id}>
            <p>
              <strong>{kindLabel[m.kind]}</strong> · {new Date(m.createdAt).toLocaleString()} ·{' '}
              {m.provenance.replaceAll('_', ' ')}
            </p>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</p>
          </li>
        ))}
      </ol>
      {ticket.delivery && (
        <p className="support-delivery">
          Reply transport: {ticket.delivery.mode} · {ticket.delivery.state}
          {ticket.delivery.reason && ` · ${ticket.delivery.reason.replaceAll('_', ' ')}`} —{' '}
          {ticket.delivery.mode === 'capture'
            ? 'No email was sent.'
            : 'Provider acceptance does not confirm inbox delivery.'}
        </p>
      )}
    </>
  );
}
