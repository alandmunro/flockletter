import { DateAutomationPanel } from './DateAutomationPanel.js';
import {Segments} from './Segments.js';
import {AudienceOnboarding} from './AudienceOnboarding.js';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Brand } from '../shared/contracts.js';
import {
  notTextableLabel,
  stateLabel,
  subscriberStates,
  textStateLabel,
  textStates,
  type AudienceContact,
  type AudienceSummary,
  type ContactDetail,
  type ContactPage,
  type PeopleSummary,
  type SpecialDate,
  type SubscriberState,
  type TextState,
} from '../shared/audience.js';
import { operationKey, type Api } from './api.js';
import { AudienceTable, displayName, formatDate, formatPhone, type DateColumns } from './AudienceTable.js';
import { ConsentTimeline } from './ConsentTimeline.js';
import { ImportPreview } from './ImportPreview.js';
import { AudienceExport } from './AudienceExport.js';
import './audience.css';

const explain = (error: unknown) =>
  error instanceof Error ? error.message : 'The audience could not be loaded. Please retry.';
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
type Summary = AudienceSummary & { people?: PeopleSummary };
type Filters = { search: string; state: SubscriberState | 'no_email' | ''; text: TextState | ''; dates: 'birthday' | 'anniversary' | 'any' | ''; month: string };
const noFilters: Filters = { search: '', state: '', text: '', dates: '', month: '' };

export function Audience({ api, brands, canManageAutomations, onSetup }: { api: Api; brands: Brand[]; canManageAutomations: boolean; onSetup: () => void }) {
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
        <BrandAudience key={brand.id} api={api} brand={brand} canManageAutomations={canManageAutomations} onSetup={onSetup} />
      ) : (
        <p>Select a brand to see its audience.</p>
      )}
    </>
  );
}

function BrandAudience({ api, brand, canManageAutomations, onSetup }: { api: Api; brand: Brand; canManageAutomations: boolean; onSetup: () => void }) {
  const [draft, setDraft] = useState<Filters>(noFilters);
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const [id, setId] = useState('');
  const [revision, setRevision] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const controls = useId();
  const restoreFocus = useRef(false);
  const cursor = pages[pages.length - 1] ?? null;
  useEffect(() => {
    if (!id && restoreFocus.current) {
      searchRef.current?.focus();
      restoreFocus.current = false;
    }
  }, [id]);
  function apply(next: Filters) {
    setDraft(next);
    setFilters({ ...next, search: next.search.trim() });
    setPages([null]);
  }
  function applySearch(event: FormEvent) {
    event.preventDefault();
    apply(draft);
  }
  // Stable, so children that depend on it don't reload when the totals arrive.
  const changed = useCallback(() => {
    setRevision((value) => value + 1);
    setPages([null]);
  }, []);
  const filtered = JSON.stringify(filters) !== JSON.stringify(noFilters);
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
        <form className="audience-controls" onSubmit={applySearch}>
          <label>
            Search email, name or phone
            <input
              ref={searchRef}
              type="search"
              maxLength={100}
              autoComplete="off"
              value={draft.search}
              onChange={(e) => setDraft({ ...draft, search: e.target.value })}
            />
          </label>
          <button className="btn secondary" type="submit">
            Search
          </button>
          <div className="audience-filter">
            <label htmlFor={controls + 'email'}>Email</label>
            <select
              id={controls + 'email'}
              value={draft.state}
              onChange={(e) => apply({ ...draft, state: e.target.value as Filters['state'] })}
            >
              <option value="">Any email status</option>
              {subscriberStates.map((s) => (
                <option key={s} value={s}>
                  {stateLabel[s]}
                </option>
              ))}
              <option value="no_email">No email (text only)</option>
            </select>
          </div>
          <div className="audience-filter">
            <label htmlFor={controls + 'text'}>Texts</label>
            <select
              id={controls + 'text'}
              value={draft.text}
              onChange={(e) => apply({ ...draft, text: e.target.value as Filters['text'] })}
            >
              <option value="">Any text status</option>
              {textStates.map((s) => (
                <option key={s} value={s}>
                  {textStateLabel[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="audience-filter">
            <label htmlFor={controls + 'dates'}>Special dates</label>
            <select
              id={controls + 'dates'}
              value={draft.dates}
              onChange={(e) => apply({ ...draft, dates: e.target.value as Filters['dates'] })}
            >
              <option value="">Any</option>
              <option value="any">Has a birthday or anniversary</option>
              <option value="birthday">Has a birthday</option>
              <option value="anniversary">Has an anniversary</option>
            </select>
          </div>
          <div className="audience-filter">
            <label htmlFor={controls + 'month'}>Date falls in</label>
            <select
              id={controls + 'month'}
              value={draft.month}
              onChange={(e) => apply({ ...draft, month: e.target.value })}
            >
              <option value="">Any month</option>
              {monthNames.map((m, i) => (
                <option key={m} value={String(i + 1)}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          {filtered && (
            <button className="btn secondary" type="button" onClick={() => apply(noFilters)}>
              Clear filters
            </button>
          )}
        </form>
        <DirectoryResults
          key={JSON.stringify([filters, cursor, revision])}
          api={api}
          brandId={brand.id}
          filters={filters}
          cursor={cursor}
          page={pages.length}
          onSelect={setId}
          previous={() => setPages((v) => v.slice(0, -1))}
          next={(value) => setPages((v) => [...v, value])}
        />
      </section>
      {canManageAutomations && <DateAutomationPanel api={api} brandId={brand.id}/>}
      <AudienceOnboarding api={api} brandId={brand.id} onChanged={changed}/>
      <Segments key={brand.id} api={api} brandId={brand.id} />
      <ImportPreview api={api} brand={brand} onApplied={changed} />
      <AudienceExport api={api} brand={brand} />
      <button type="button" className="btn secondary" onClick={onSetup}>
        View signup connection settings
      </button>
    </>
  );
}

function Counts({ api, brandId }: { api: Api; brandId: string }) {
  const [summary, setSummary] = useState<Summary>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    api
      .call<Summary>('audience.summary', { brandId })
      .then((value) => {
        if (current) setSummary(value);
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
  if (!summary) return <p role="status">Loading audience totals…</p>;
  const people = summary.people;
  const groups: [string, [string, number][]][] = [
    ['Email', [
      ['Confirmed', summary.confirmed],
      ['Pending confirmation', summary.pending],
      ['Suppressed', summary.unsubscribed + summary.hard_bounced + summary.complained],
      ['Total email contacts', summary.total],
    ]],
  ];
  if (people) {
    groups.push(['Texts', [
      ['Subscribed', people.text.opted_in],
      ['Waiting for YES', people.text.pending_confirmation],
      ['Opted out', people.text.opted_out + people.text.pending_reenrollment],
      ["Can't text", people.text.not_textable],
      ['Phone, not subscribed', people.text.phone_only + people.text.expired],
      ['Text only (no email)', people.phoneOnly],
    ]]);
    if (people.birthdays || people.anniversaries)
      groups.push(['Special dates', [
        ['Birthdays', people.birthdays],
        ['Anniversaries', people.anniversaries],
        ['This month', people.thisMonth],
      ]]);
  }
  return (
    <div className="audience-count-groups">
      {groups.map(([title, items]) => (
        <section key={title} aria-label={title + ' totals'}>
          <h2 className="audience-count-title">{title}</h2>
          <dl className="audience-counts">
            {items.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

type ResultsProps = {
  api: Api;
  brandId: string;
  filters: Filters;
  cursor: string | null;
  page: number;
  onSelect: (id: string) => void;
  previous: () => void;
  next: (cursor: string) => void;
};
function DirectoryResults({ api, brandId, filters, cursor, page, onSelect, previous, next }: ResultsProps) {
  const [result, setResult] = useState<ContactPage>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    api
      .call<ContactPage>('audience.list', {
        brandId,
        state: filters.state || undefined,
        text: filters.text || undefined,
        search: filters.search || undefined,
        dates: filters.dates || undefined,
        month: filters.month ? Number(filters.month) : undefined,
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
  }, [api, brandId, filters, cursor, retry]);
  // Date columns appear only when someone on this page has that date.
  const items = result?.items ?? [];
  const dates: DateColumns = {
    birthday: items.some((c) => c.birthday) || filters.dates === 'birthday',
    anniversary: items.some((c) => c.anniversary) || filters.dates === 'anniversary',
    anniversaryLabel: items.find((c) => c.anniversary)?.anniversary?.label ?? 'Anniversary',
  };
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
        <AudienceTable contacts={result.items} onSelect={onSelect} dates={dates} />
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

const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
function textExplanation(data: NonNullable<ContactDetail['texting']>) {
  const number = data.number ? formatPhone(data.number) : 'your texting number';
  switch (data.state) {
    case 'opted_in': return `Subscribed${data.changedAt ? ' since ' + shortDate(data.changedAt) : ''}. They can text STOP at any time.`;
    case 'pending_confirmation': return `We texted asking them to reply YES${data.changedAt ? ' on ' + shortDate(data.changedAt) : ''}.${data.pendingExpiresAt ? ' The request expires ' + shortDate(data.pendingExpiresAt) + '.' : ''} Nothing else is sent until they reply YES.`;
    case 'expired': return 'They never replied YES, so the request expired. They can opt in again on your sign-up page.';
    case 'opted_out': return `Texts are stopped${data.changedAt ? ' since ' + shortDate(data.changedAt) : ''}. Only they can restart them, by texting START to ${number}.`;
    case 'pending_reenrollment': return `They signed up again after opting out. Nothing is sent until they text START to ${number}.`;
    case 'not_textable': return `This number can't receive texts: ${notTextableLabel[data.notTextableReason ?? ''] ?? 'the carrier refused it'}.`;
    case 'phone_only': return 'They gave a phone number but did not tick the text box. They can opt in on your sign-up page.';
    default: return '';
  }
}
const textEventLabel: Record<string, string> = {
  checkbox_opt_in: 'Ticked the text box on the sign-up page', confirmed: 'Replied YES', expired: 'YES request expired',
  opted_out: 'Texts stopped', help: 'Texted HELP', opted_in_start: 'Texted START', reenrollment_pending: 'Signed up again after STOP',
  not_textable: 'Number marked as unable to receive texts',
};
const textSourceLabel: Record<string, string> = {
  signup_page: 'sign-up page', inbound_sms: 'their text', owner: 'by you', worker: 'automatic', delivery_status: 'carrier',
};

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
  const [review, setReview] = useState<'' | 'email' | 'texts'>('');
  const [editing, setEditing] = useState(false);
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
    setReview('');
    setPages(next);
  }
  async function act(run: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      setNotice(await run());
      setReview('');
      setEditing(false);
      turnPage([null]);
      setRevision((v) => v + 1);
      onChanged();
    } catch (e) {
      setActionError(explain(e));
    } finally {
      setBusy(false);
    }
  }
  const optOut = () =>
    act(async () => {
      await api.call('audience.unsubscribe', { brandId: brand.id, id });
      return 'Email marketing is stopped for this contact.';
    });
  const stopTexts = () =>
    act(async () => {
      await api.call('audience.stopTexts', { brandId: brand.id, id, operationKey: operationKey() });
      return 'Texts are stopped for this number.';
    });
  const save = (changes: Record<string, unknown>) =>
    act(async () => {
      const result = await api.call<{ warning?: string }>('audience.updateContact', { brandId: brand.id, id, operationKey: operationKey(), ...changes });
      return result.warning ? 'Saved. ' + result.warning : 'Contact details saved.';
    });
  const contact = data?.contact;
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
      {actionError && (
        <p role="alert" className="notice error">
          {actionError}
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
      ) : !data || !contact ? (
        <p role="status">Loading contact…</p>
      ) : (
        <div className="contact-detail-grid">
          <section className="card contact-identity">
            <h2>{displayName(contact) || contact.email || formatPhone(contact.phone)}</h2>
            {editing ? (
              <ContactEditor contact={contact} detail={data} busy={busy} save={save} cancel={() => setEditing(false)} />
            ) : (
              <>
                <dl>
                  <dt>Name</dt>
                  <dd>{displayName(contact) || '-'}</dd>
                  <dt>Email</dt>
                  <dd>{contact.email ?? 'No email (text only)'}</dd>
                  <dt>Phone</dt>
                  <dd>{contact.phone ? formatPhone(contact.phone) : '-'}</dd>
                  {data.sharedWith.length > 0 && (
                    <>
                      <dt>Phone shared with</dt>
                      <dd>{data.sharedWith.join(', ')}</dd>
                    </>
                  )}
                  {(data.fields.birthday || contact.birthday) && (
                    <>
                      <dt>Birthday</dt>
                      <dd>{formatDate(contact.birthday)}</dd>
                    </>
                  )}
                  {(data.fields.anniversary || contact.anniversary) && (
                    <>
                      <dt>{contact.anniversary?.label || data.fields.anniversaryLabel}</dt>
                      <dd>{formatDate(contact.anniversary)}</dd>
                    </>
                  )}
                  <dt>Added</dt>
                  <dd>{new Date(contact.createdAt).toLocaleString()}</dd>
                </dl>
                <button className="btn secondary" disabled={busy} onClick={() => { setNotice(''); setEditing(true); }}>
                  Edit details
                </button>
              </>
            )}
          </section>
          <section className="card">
            <h2>Email</h2>
            {contact.state ? (
              <>
                <span className={'contact-state state-' + contact.state}>{stateLabel[contact.state]}</span>
                {contact.confirmedAt && <p>Subscribed on {new Date(contact.confirmedAt).toLocaleString()}</p>}
                {['pending', 'confirmed'].includes(contact.state) &&
                  (review === 'email' ? (
                    <Confirm
                      text={`Stop email marketing to this contact for ${brand.name}? A repeat signup will keep this choice. Texts are not affected.`}
                      action="Confirm email unsubscribe"
                      busy={busy}
                      confirm={() => void optOut()}
                      cancel={() => setReview('')}
                    />
                  ) : (
                    <button className="btn secondary" onClick={() => setReview('email')}>
                      Unsubscribe from email
                    </button>
                  ))}
              </>
            ) : (
              <p>No email address. This person signed up for texts only.</p>
            )}
          </section>
          <section className="card">
            <h2>Texts</h2>
            {!data.texting ? (
              <p>No phone number on file.{contact.kind === 'subscriber' ? ' You can add one with Edit details; adding a number never subscribes anyone.' : ''}</p>
            ) : (
              <>
                <span className={'contact-state text-' + data.texting.state}>{textStateLabel[data.texting.state]}</span>
                {data.texting.companyName && <p className="help">For {data.texting.companyName}{data.texting.number ? ', from ' + formatPhone(data.texting.number) : ''}.</p>}
                <p>{textExplanation(data.texting)}</p>
                {!['opted_out', 'not_textable'].includes(data.texting.state) &&
                  (review === 'texts' ? (
                    <Confirm
                      text="Stop all texts to this number? Only they can restart texts, by texting START. Email is not affected."
                      action="Confirm stop texting"
                      busy={busy}
                      confirm={() => void stopTexts()}
                      cancel={() => setReview('')}
                    />
                  ) : (
                    <button className="btn secondary" onClick={() => setReview('texts')}>
                      Stop texting this contact
                    </button>
                  ))}
                <p className="help">There is no button to start texts. People subscribe themselves on your sign-up page and reply YES.</p>
                {data.texting.events.length > 0 && (
                  <>
                    <h3>Text history</h3>
                    <ol className="text-history">
                      {data.texting.events.map((e) => (
                        <li key={e.id}>
                          <time dateTime={e.recordedAt}>{new Date(e.recordedAt).toLocaleString()}</time>{' '}
                          {textEventLabel[e.event] ?? e.event}
                          {textSourceLabel[e.source] ? ` (${textSourceLabel[e.source]})` : ''}
                          {e.wording && <span className="help"> Wording shown: “{e.wording}”</span>}
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </>
            )}
          </section>
          {contact.kind === 'subscriber' && (
            <section className="card">
              <h2>Email consent history</h2>
              {data.practiceImport && <p>Added from practice CSV row {data.practiceImport.row} on{' '}
                {new Date(data.practiceImport.recordedAt).toLocaleDateString()}. The owner declared permission for fictional contacts.</p>}
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
          )}
        </div>
      )}
    </>
  );
}

function Confirm({ text, action, busy, confirm, cancel }: { text: string; action: string; busy: boolean; confirm: () => void; cancel: () => void }) {
  return (
    <div className="unsubscribe-review">
      <p>{text}</p>
      <div className="actions">
        <button className="btn danger" disabled={busy} onClick={confirm}>
          {action}
        </button>
        <button className="btn secondary" disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type DateDraft = { month: string; day: string; year: string };
const toDraft = (date: SpecialDate | null): DateDraft => ({ month: date ? String(date.month) : '', day: date ? String(date.day) : '', year: date?.year ? String(date.year) : '' });
function fromDraft(draft: DateDraft, withYear: boolean) {
  if (!draft.month && !draft.day) return null;
  const month = Number(draft.month), day = Number(draft.day), year = Number(draft.year);
  return { month, day, ...(withYear && draft.year ? { year } : {}) };
}
function sameDate(a: SpecialDate | null, b: ReturnType<typeof fromDraft>) {
  if (!a || !b) return a === b;
  return a.month === b.month && a.day === b.day && (a.year ?? undefined) === ('year' in b ? b.year : undefined);
}

function ContactEditor({ contact, detail, busy, save, cancel }: {
  contact: AudienceContact; detail: ContactDetail; busy: boolean; save: (changes: Record<string, unknown>) => void; cancel: () => void;
}) {
  const [first, setFirst] = useState(contact.firstName ?? '');
  const [last, setLast] = useState(contact.lastName ?? '');
  const [phone, setPhone] = useState(contact.phone ? formatPhone(contact.phone) : '');
  const [birthday, setBirthday] = useState(toDraft(contact.birthday));
  const [anniversary, setAnniversary] = useState(toDraft(contact.anniversary));
  const [problem, setProblem] = useState('');
  const showBirthday = detail.fields.birthday || !!contact.birthday;
  const showAnniversary = detail.fields.anniversary || !!contact.anniversary;
  const anniversaryLabel = contact.anniversary?.label || detail.fields.anniversaryLabel;
  function submit(event: FormEvent) {
    event.preventDefault();
    const changes: Record<string, unknown> = {};
    if (first.trim() !== (contact.firstName ?? '')) changes.firstName = first.trim() || null;
    if (last.trim() !== (contact.lastName ?? '')) changes.lastName = last.trim() || null;
    if (contact.kind === 'subscriber' && phone.replace(/\D/g, '') !== (contact.phone ?? '').replace(/^\+1/, '').replace(/\D/g, ''))
      changes.phone = phone.trim() || null;
    for (const [key, draft, current, withYear] of [
      ['birthday', birthday, contact.birthday, false],
      ['anniversary', anniversary, contact.anniversary, true],
    ] as const) {
      if ((draft.month === '') !== (draft.day === '')) {
        setProblem(`Choose both the month and day for ${key === 'birthday' ? 'the birthday' : anniversaryLabel.toLowerCase()}, or clear both.`);
        return;
      }
      const value = fromDraft(draft, withYear);
      if (!sameDate(current, value)) changes[key] = value;
    }
    if (!Object.keys(changes).length) return cancel();
    setProblem('');
    save(changes);
  }
  return (
    <form className="contact-editor" onSubmit={submit}>
      <fieldset disabled={busy}>
        <div className="contact-editor-row">
          <label>
            First name
            <input maxLength={60} value={first} autoComplete="off" onChange={(e) => setFirst(e.target.value)} />
          </label>
          <label>
            Last name
            <input maxLength={60} value={last} autoComplete="off" onChange={(e) => setLast(e.target.value)} />
          </label>
        </div>
        <p className="help">Email: {contact.email ?? 'none'}. An email address can't be changed here, because its consent record belongs to that address.</p>
        {contact.kind === 'subscriber' ? (
          <label>
            Mobile phone (US)
            <input type="tel" maxLength={20} value={phone} onChange={(e) => setPhone(e.target.value)} />
            <span className="help">
              Text consent belongs to the number, not the person. Adding or changing a number never subscribes anyone, and a removed
              number keeps its own STOP history.
            </span>
          </label>
        ) : (
          <p className="help">Phone: {formatPhone(contact.phone)}. A text-only contact is identified by its number, so it can't be changed.</p>
        )}
        {showBirthday && <DateFields legend="Birthday" value={birthday} onChange={setBirthday} />}
        {showAnniversary && <DateFields legend={anniversaryLabel} value={anniversary} onChange={setAnniversary} withYear />}
        {problem && (
          <p role="alert" className="notice error">
            {problem}
          </p>
        )}
        <div className="actions">
          <button className="btn" type="submit">
            Save details
          </button>
          <button className="btn secondary" type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function DateFields({ legend, value, onChange, withYear = false }: { legend: string; value: DateDraft; onChange: (v: DateDraft) => void; withYear?: boolean }) {
  return (
    <fieldset className="contact-date">
      <legend>{legend}</legend>
      <select aria-label={legend + ' month'} value={value.month} onChange={(e) => onChange({ ...value, month: e.target.value })}>
        <option value="">Month</option>
        {monthNames.map((m, i) => (
          <option key={m} value={String(i + 1)}>
            {m}
          </option>
        ))}
      </select>
      <select aria-label={legend + ' day'} value={value.day} onChange={(e) => onChange({ ...value, day: e.target.value })}>
        <option value="">Day</option>
        {Array.from({ length: 31 }, (_, i) => (
          <option key={i} value={String(i + 1)}>
            {i + 1}
          </option>
        ))}
      </select>
      {withYear && (
        <input aria-label={legend + ' year'} inputMode="numeric" pattern="[0-9]{4}" maxLength={4} placeholder="Year (optional)"
          value={value.year} onChange={(e) => onChange({ ...value, year: e.target.value })} />
      )}
      {(value.month || value.day) && (
        <button type="button" className="btn secondary" onClick={() => onChange({ month: '', day: '', year: '' })}>
          Remove
        </button>
      )}
    </fieldset>
  );
}
