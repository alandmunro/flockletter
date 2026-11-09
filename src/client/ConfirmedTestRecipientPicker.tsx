import type { AudienceContact } from '../shared/audience.js';

type Props = {
  prefix: string;
  contacts: AudienceContact[];
  selectedId: string;
  busy: boolean;
  search: string;
  error?: string;
  hasMore: boolean;
  onSelect: (id: string) => void;
  onSearchChange: (value: string) => void;
  onSearch: () => void;
  onNext: () => void;
  onRefresh: () => void;
};

export function ConfirmedTestRecipientPicker({
  prefix,
  contacts,
  selectedId,
  busy,
  search,
  error,
  hasMore,
  onSelect,
  onSearchChange,
  onSearch,
  onNext,
  onRefresh,
}: Props) {
  const searchId = prefix + '-search';
  const recipientId = prefix + '-recipient';
  const confirmed = contacts.filter((c) => c.state === 'confirmed');

  return (
    <div className="card">
      <form onSubmit={(event) => {event.preventDefault();onSearch();}}>
        <div className="field">
          <label htmlFor={searchId}>Find an existing confirmed contact</label>
          <div className="actions">
            <input
              id={searchId}
              type="email"
              maxLength={254}
              autoComplete="off"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              disabled={busy}
            />
            <button type="submit" className="btn secondary" disabled={busy}>
              Find contact
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor={recipientId}>Test recipient</label>
          <select
            id={recipientId}
            value={selectedId}
            onChange={(e) => onSelect(e.target.value)}
            disabled={busy}
          >
            <option value="">Choose one confirmed contact</option>
            {selectedId && !confirmed.some((c) => c.id === selectedId) && (
              <option value={selectedId} disabled>
                Choose a current confirmed contact
              </option>
            )}
            {confirmed.map((c) => (
              <option key={c.id} value={c.id}>
                {c.email}
              </option>
            ))}
          </select>
        </div>

        {confirmed.length === 0 && !busy && !error && <p className="notice">No confirmed contacts found.</p>}
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}

        <p className="help">
          Only already-confirmed contacts in the selected brand are eligible. The server rechecks consent and suppression before any send.
        </p>

        <div className="actions">
          {hasMore && (
            <button type="button" className="btn secondary" onClick={onNext} disabled={busy}>
              Next contacts
            </button>
          )}
          <button type="button" className="btn secondary" onClick={onRefresh} disabled={busy}>
            Refresh confirmed contacts
          </button>
        </div>
      </form>
    </div>
  );
}
