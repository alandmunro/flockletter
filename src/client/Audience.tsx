import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Brand } from '../shared/contracts.js';
import {
  stateLabel,
  subscriberStates,
  type AudienceSummary,
  type ContactDetail,
  type ContactPage,
  type SubscriberState,
} from '../shared/audience.js';
import type { Api } from './api.js';
import { AudienceTable } from './AudienceTable.js';
import { ConsentTimeline } from './ConsentTimeline.js';
import './audience.css';

const explain = (error: unknown) =>
  error instanceof Error ? error.message : 'The audience could not be loaded. Please retry.';

export function Audience({ api, brands, onSetup }: { api: Api; brands: Brand[]; onSetup: () => void }) {
  const [selectedBrand, setBrand] = useState(brands[0]?.id ?? '');
  const brandControl = useId();
  const brand = brands.find((item) => item.id === selectedBrand);
  return (
    <>
      {brands.length > 1 && (
        <div className="audience-brand">
          <label htmlFor={brandControl}>Brand</label>
          <select id={brandControl} value={selectedBrand} onChange={(event) => setBrand(event.target.value)}>
            {brands.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {brand ? (
        <BrandAudience key={brand.id} api={api} brand={brand} onSetup={onSetup} />
      ) : (
        <p>Select a brand to see its audience.</p>
      )}
    </>
  );
}

function BrandAudience({ api, brand, onSetup }: { api: Api; brand: Brand; onSetup: () => void }) {
  const [search, setSearch] = useState('');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<SubscriberState | ''>('');
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const [id, setId] = useState('');
  const [revision, setRevision] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const statusControl = useId();
  const restoreFocus = useRef(false);
  const cursor = pages[pages.length - 1] ?? null;
  useEffect(() => {
    if (!id && restoreFocus.current) {
      searchRef.current?.focus();
      restoreFocus.current = false;
    }
  }, [id]);
  function applySearch(event: FormEvent) {
    event.preventDefault();
    setEmail(search.trim());
    setPages([null]);
  }
  function changed() {
    setRevision((value) => value + 1);
    setPages([null]);
  }
  if (id)
    return (
      <ContactRecord
        key={id}
        api={api}
        brand={brand}
        id={id}
        onChanged={changed}
        back={() => {
          restoreFocus.current = true;
          setId('');
        }}
      />
    );
  return (
    <>
      <p className="eyebrow">{brand.name} / Audience</p>
      <h1 className="page-heading">Audience</h1>
      <Counts key={revision} api={api} brandId={brand.id} />
      <section className="card" aria-labelledby="contact-heading">
        <h2 id="contact-heading">Contacts</h2>
        <div className="audience-controls">
          <form onSubmit={applySearch}>
            <label>
              Find an exact email
              <input
                ref={searchRef}
                type="email"
                maxLength={254}
                autoComplete="off"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button className="btn secondary" type="submit">
              Search
            </button>
            {email && (
              <button
                className="btn secondary"
                type="button"
                onClick={() => {
                  setSearch('');
                  setEmail('');
                  setPages([null]);
                }}
              >
                Clear search
              </button>
            )}
          </form>
          <div>
            <label htmlFor={statusControl}>Status</label>
            <select
              id={statusControl}
              value={state}
              onChange={(e) => {
                setState(e.target.value as SubscriberState | '');
                setPages([null]);
              }}
            >
              <option value="">All statuses</option>
              {subscriberStates.map((s) => (
                <option key={s} value={s}>
                  {stateLabel[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DirectoryResults
          key={JSON.stringify([email, state, cursor, revision])}
          api={api}
          brandId={brand.id}
          email={email}
          state={state}
          cursor={cursor}
          page={pages.length}
          onSelect={setId}
          previous={() => setPages((v) => v.slice(0, -1))}
          next={(value) => setPages((v) => [...v, value])}
        />
      </section>
      <button type="button" className="btn secondary" onClick={onSetup}>
        View signup connection settings
      </button>
    </>
  );
}

function Counts({ api, brandId }: { api: Api; brandId: string }) {
  const [counts, setCounts] = useState<AudienceSummary>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    api
      .call<AudienceSummary>('audience.summary', { brandId })
      .then((value) => {
        if (current) setCounts(value);
      })
      .catch((e) => {
        if (current) setError(explain(e));
      });
    return () => {
      current = false;
    };
  }, [api, brandId, retry]);
  if (error)
    return (
      <div role="alert">
        {error}{' '}
        <button
          className="btn secondary"
          onClick={() => {
            setError('');
            setRetry((v) => v + 1);
          }}
        >
          Retry counts
        </button>
      </div>
    );
  if (!counts) return <p role="status">Loading audience totals…</p>;
  return (
    <dl className="audience-counts" aria-label="Brand audience totals">
      {[
        ['Total contacts', counts.total],
        ['Confirmed', counts.confirmed],
        ['Pending confirmation', counts.pending],
        ['Suppressed', counts.unsubscribed + counts.hard_bounced + counts.complained],
      ].map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value?.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

type ResultsProps = {
  api: Api;
  brandId: string;
  email: string;
  state: SubscriberState | '';
  cursor: string | null;
  page: number;
  onSelect: (id: string) => void;
  previous: () => void;
  next: (cursor: string) => void;
};
function DirectoryResults({
  api,
  brandId,
  email,
  state,
  cursor,
  page,
  onSelect,
  previous,
  next,
}: ResultsProps) {
  const [result, setResult] = useState<ContactPage>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    api
      .call<ContactPage>('audience.list', {
        brandId,
        state: state || undefined,
        email: email || undefined,
        cursor: cursor ?? undefined,
      })
      .then((value) => {
        if (current) setResult(value);
      })
      .catch((e) => {
        if (current) setError(explain(e));
      });
    return () => {
      current = false;
    };
  }, [api, brandId, email, state, cursor, retry]);
  return (
    <>
      {error ? (
        <div role="alert">
          {error}{' '}
          <button
            className="btn secondary"
            onClick={() => {
              setError('');
              setRetry((v) => v + 1);
            }}
          >
            Retry contacts
          </button>
        </div>
      ) : result ? (
        <AudienceTable contacts={result.items} onSelect={onSelect} />
      ) : (
        <p role="status">Loading contacts…</p>
      )}
      {(page > 1 || result?.nextCursor) && (
        <nav className="actions audience-pager" aria-label="Contact pages">
          <button className="btn secondary" disabled={page === 1} onClick={previous}>
            Previous contacts
          </button>
          <span>Page {page}</span>
          <button
            className="btn secondary"
            disabled={!result?.nextCursor}
            onClick={() => {
              if (result?.nextCursor) next(result.nextCursor);
            }}
          >
            Next contacts
          </button>
        </nav>
      )}
    </>
  );
}

function ContactRecord({
  api,
  brand,
  id,
  back,
  onChanged,
}: {
  api: Api;
  brand: Brand;
  id: string;
  back: () => void;
  onChanged: () => void;
}) {
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<ContactDetail>();
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const cursor = pages[pages.length - 1] ?? null;
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    let current = true;
    api
      .call<ContactDetail>('audience.contact', { brandId: brand.id, id, cursor: cursor ?? undefined })
      .then((value) => {
        if (current) setData(value);
      })
      .catch((e) => {
        if (current) setError(explain(e));
      });
    return () => {
      current = false;
    };
  }, [api, brand.id, id, cursor, revision]);
  function turnPage(next: (string | null)[]) {
    setData(undefined);
    setError('');
    setReview(false);
    setPages(next);
  }
  async function optOut() {
    if (busy || !review) return;
    setBusy(true);
    setActionError('');
    try {
      await api.call('audience.unsubscribe', { brandId: brand.id, id });
      setReview(false);
      setNotice('Marketing is stopped for this contact.');
      turnPage([null]);
      setRevision((v) => v + 1);
      onChanged();
    } catch (e) {
      setActionError(explain(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="btn secondary" disabled={busy} onClick={back}>
        ← All contacts
      </button>
      <p className="eyebrow">{brand.name} / Audience</p>
      <h1 className="page-heading" ref={heading} tabIndex={-1}>
        Contact details
      </h1>
      {notice && (
        <p role="status" className="notice success">
          {notice}
        </p>
      )}
      {error ? (
        <div role="alert">
          {error}{' '}
          <button
            className="btn secondary"
            onClick={() => {
              setError('');
              setRevision((v) => v + 1);
            }}
          >
            Retry contact
          </button>
        </div>
      ) : !data ? (
        <p role="status">Loading contact…</p>
      ) : (
        <div className="contact-detail-grid">
          <section className="card contact-identity">
            <h2>{data.contact.email}</h2>
            <span className={'contact-state state-' + data.contact.state}>
              {stateLabel[data.contact.state]}
            </span>
            <dl>
              <dt>Added</dt>
              <dd>{new Date(data.contact.createdAt).toLocaleString()}</dd>
              {data.contact.confirmedAt && (
                <>
                  <dt>Confirmed on</dt>
                  <dd>{new Date(data.contact.confirmedAt).toLocaleString()}</dd>
                </>
              )}
            </dl>
            {['pending', 'confirmed'].includes(data.contact.state) &&
              (review ? (
                <div className="unsubscribe-review">
                  <p>
                    Stop marketing to this contact for {brand.name}? A repeat signup will keep this choice.
                  </p>
                  <div className="actions">
                    <button className="btn danger" disabled={busy} onClick={() => void optOut()}>
                      Confirm unsubscribe
                    </button>
                    <button
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => {
                        setReview(false);
                        setActionError('');
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn secondary" onClick={() => setReview(true)}>
                  Unsubscribe contact
                </button>
              ))}
            {actionError && (
              <p role="alert" className="notice error">
                {actionError}
              </p>
            )}
          </section>
          <section className="card">
            <h2>Consent history</h2>
            <ConsentTimeline events={data.events} />
            {(pages.length > 1 || data.nextCursor) && (
              <nav className="actions" aria-label="Consent history pages">
                <button
                  className="btn secondary"
                  disabled={busy || pages.length === 1}
                  onClick={() => turnPage(pages.slice(0, -1))}
                >
                  Newer events
                </button>
                <button
                  className="btn secondary"
                  disabled={busy || !data.nextCursor}
                  onClick={() => {
                    if (data.nextCursor) turnPage([...pages, data.nextCursor]);
                  }}
                >
                  Older events
                </button>
              </nav>
            )}
          </section>
        </div>
      )}
    </>
  );
}
