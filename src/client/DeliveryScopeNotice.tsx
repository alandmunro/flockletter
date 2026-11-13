import {externalDelivery} from '../shared/customer-delivery.js';
import type { DeliveryMode, DeliveryScope } from '../shared/customer-delivery.js';


export function DeliveryScopeNotice({ mode, scope }: { mode: DeliveryMode; scope: DeliveryScope }) {
  if (scope === 'all') return null;
  if (mode === 'capture') {
    return (
      <p role="status" className="notice">
        Only reviewed one-recipient tests are allowed. Broadcasts and schedules are disabled. Messages remain captured in staging. A group named “Test” is still a group; select one confirmed member in the test panel below.
      </p>
    );
  }
  if (externalDelivery(mode)) {
    return (
      <p role="status" className="notice">
        Only separately approved tests to one confirmed contact can leave the app. Broadcasts and schedules are disabled. Existing sender, consent, and service checks apply, along with the shared five-tests-per-UTC-day limit. A group named “Test” does not change this restriction. Select one intended confirmed member below and review that exact recipient; each approval counts toward the daily limit.
      </p>
    );
  }
  return (
    <p role="status" className="notice">
      Delivery is off. No email leaves.
    </p>
  );
}
