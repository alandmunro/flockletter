import type { DeliveryMode, DeliveryScope } from '../shared/customer-delivery.js';


export function DeliveryScopeNotice({ mode, scope }: { mode: DeliveryMode; scope: DeliveryScope }) {
  if (scope === 'all') return null;
  if (mode === 'capture') {
    return (
      <p role="status" className="notice">
        Only reviewed one-recipient tests are allowed. Broadcasts and schedules are disabled. Messages remain captured in staging.
      </p>
    );
  }
  if (mode === 'ses') {
    return (
      <p role="status" className="notice">
        Only separately approved tests to one confirmed contact can leave the app. Broadcasts and schedules are disabled. Existing sender, consent, and service checks apply, along with the shared five-tests-per-UTC-day limit.
      </p>
    );
  }
  return (
    <p role="status" className="notice">
      Delivery is off. No email leaves.
    </p>
  );
}
