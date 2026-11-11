import type { ConsentEvent } from '../shared/audience.js';

const eventTitles: Record<ConsentEvent['event'], string> = {
  signup_requested: 'Signup requested',
  confirmed: 'Email confirmed',
  unsubscribed: 'Unsubscribed',
  suppressed: 'Delivery suppressed',
};

const sourceLabels: Record<string, string> = {
  'storefront-footer': 'Storefront footer',
  'storefront-homepage': 'Storefront homepage',
  'workspace-owner': 'Workspace owner',
  'marketing-unsubscribe-link': 'Marketing unsubscribe link',
  'confirmation-link': 'Confirmation link',
  unsubscribed: 'Unsubscribe link',
  hard_bounced: 'Hard bounce',
  complained: 'Complaint',
};

export function ConsentTimeline({ events }: { events: ConsentEvent[] }) {
  if (events.length === 0) return <p>No consent events recorded.</p>;

  return (
    <ol className="consent-timeline">
      {events.map((event) => {
        const date = new Date(event.recordedAt);

        return (
          <li key={event.id}>
            <p>
              <strong>{event.event === 'confirmed' && /-(?:single-opt-in|owner-attestation)$/.test(event.source) ? 'Subscribed without email verification' : eventTitles[event.event]}</strong>{' '}
              <time dateTime={event.recordedAt}>{date.toLocaleString()}</time>
            </p>
            <dl>
              <dt>Source</dt>
              <dd>{Object.hasOwn(sourceLabels, event.source) ? sourceLabels[event.source] : event.source}</dd>
              {event.evidenceSource && <><dt>Permission source</dt><dd>{event.evidenceSource}</dd></>}
              {event.recordedBy && <><dt>Recorded by</dt><dd>{event.recordedBy}</dd></>}
              <dt>Policy version</dt>
              <dd>{event.policyVersion}</dd>
              <dt>Purpose</dt>
              <dd>
                {event.purpose === 'ffa_product_marketing'
                  ? 'FFA marketing email'
                  : event.purpose === 'brand_marketing'
                    ? 'Brand marketing email'
                    : event.purpose}
              </dd>
              <dt>Signup domain</dt>
              <dd>{event.sourceDomain || 'Not recorded'}</dd>
            </dl>
          </li>
        );
      })}
    </ol>
  );
}
