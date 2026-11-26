import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  GiftAlertPreferences,
  GiftNotificationView,
  WorkspaceGiftCommand,
} from '../shared/workspace-gifts.js';
import { operationKey } from './api.js';
import './workspace-gifts.css';
import {csvCell} from './contact-export.js';

type Api = { call<T>(name: WorkspaceGiftCommand, input: unknown): Promise<T> };
type Props = { api: Api; brandId: string };
type Person = { id: string; label: string };
type Product = { id: string; name: string };
type Purchase = { id: string; face: number; total: number; state: string };
type Campaign = {
  id: string;
  title: string;
  offered: number;
  claimed: number;
  expired: number;
  reserved: number;
  spent: number;
  released: number;
  fees?: number;
  expiresAt?: string;
  open?: number;
  recipients?: { id: string; label?: string; expires?: string; state: string; claimedAt: string | null }[];
};
type Status = {
  canManage: boolean;
  eligibility: { eligible: boolean; reasons: string[]; brokerRequired?: boolean };
  closed: boolean;
  available: number;
  reserved: number;
  spent: number;
  refunded: number;
  purchases: Purchase[];
  campaigns: Campaign[];
  people: Person[];
  ledger: { kind: string; amount: number; at: string }[];
  pending?: number;
  alerts?: string[];
  ownerNotifications?: GiftNotificationView;
};
type Run = (action: () => Promise<void>, refreshAfter?: boolean) => Promise<void>;
type Mutation = <T>(
  name:
    | 'gifts.purchase'
    | 'gifts.reconcile'
    | 'gifts.launch'
    | 'gifts.close'
    | 'gifts.notificationPreferences',
  input: Record<string, unknown>,
  accept?: (result: T) => void,
) => Promise<T>;

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents: number) => usd.format(cents / 100);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'The request could not be completed.';
const pageSize = 20;
const holdReasons: Record<string, string> = {
  gifting_closed: 'Workspace gifting is closed.',
  account_on_hold: 'The workspace is on hold.',
  registration_required: 'Complete the business registration.',
  operator_verification_required: 'Operator verification is required.',
  cleared_payment_wait: 'The waiting period starts after the workspace’s first cleared payment.',
  probation_budget: 'The current gifting limit requires review.',
};

function GiftRecipientReport({ campaign: c }: { campaign: Campaign }) {
  const people = c.recipients ?? [];
  const [page, setPage] = useState(0);
  const cost = c.claimed ? money((c.spent + (c.fees ?? 0)) / c.claimed) : '—';
  function download() {
    const rows = [
      ['Campaign', 'Recipient', 'Status', 'Claimed at (UTC)', 'Expires (UTC)', 'Cost per claim (USD)'],
      ...people.map((p) => [
        c.title,
        p.label ?? p.id,
        p.state,
        p.claimedAt ?? '',
        p.expires ?? c.expiresAt ?? '',
        cost,
      ]),
    ];
    const blob = new Blob(['\uFEFF', rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gift-results-' + c.id + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <details>
      <summary>Recipient results ({people.length})</summary>
      <p>
        {c.open ?? people.filter((p) => p.state === 'offered' || p.state === 'pending').length} open · {cost}{' '}
        per claim including fees
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Recipient</th>
            <th scope="col">Status</th>
            <th scope="col">Claimed at</th>
            <th scope="col">Expires</th>
          </tr>
        </thead>
        <tbody>
          {people.slice(page * pageSize, (page + 1) * pageSize).map((p) => (
            <tr key={p.id}>
              <td>{p.label ?? p.id}</td>
              <td>{p.state}</td>
              <td>{p.claimedAt ? new Date(p.claimedAt).toLocaleString() : '—'}</td>
              <td>{p.expires ? new Date(p.expires).toLocaleDateString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {people.length > pageSize && (
        <>
          <button disabled={!page} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <button disabled={(page + 1) * pageSize >= people.length} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </>
      )}
      <button onClick={download}>Export recipient CSV</button>
    </details>
  );
}

function parseDollars(value: string) {
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(value)) return 0;
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return cents <= 10_000_000 ? cents : 0;
}

function Dollars({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change: (value: string) => void;
}) {
  return (
    <label className="wg-field">
      {label} (USD)
      <input
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
}

function CampaignForm({
  api,
  brandId,
  status,
  run,
  mutate,
  busy,
}: Props & {
  status: Status;
  run: Run;
  mutate: Mutation;
  busy: boolean;
}) {
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('5.00');
  const [days, setDays] = useState(30);
  const [catalog, setCatalog] = useState<Product[]>();
  const [productIds, setProductIds] = useState<string[]>([]);
  const [personIds, setPersonIds] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [review, setReview] = useState(false);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const face = parseDollars(amount);
  const filtered = status.people.filter((person) =>
    person.label.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const start = Math.min(offset, Math.max(0, Math.floor((filtered.length - 1) / pageSize) * pageSize));
  const page = filtered.slice(start, start + pageSize);
  const people = status.people.filter((person) => personIds.includes(person.id));
  const products = catalog?.filter((product) => productIds.includes(product.id)) ?? [];
  const required = face * people.length;
  const brokerRequired = status.eligibility.brokerRequired !== false;
  const ready =
    title.trim() &&
    face > 0 &&
    (!brokerRequired || confirmed) &&
    people.length > 0 &&
    people.length <= 1000 &&
    people.length === personIds.length &&
    (products.length === 1 || (products.length >= 5 && products.length <= 10)) &&
    required <= status.available;
  const toggle = (values: string[], id: string) =>
    values.includes(id) ? values.filter((v) => v !== id) : [...values, id];

  function loadCatalog() {
    setProductIds([]);
    setCatalog(undefined);
    void run(async () => {
      const result = await api.call<{ products: Product[] }>('gifts.catalog', { brandId, face });
      setCatalog(result.products);
    }, false);
  }

  function launch() {
    if (!review || !ready) return;
    void run(async () => {
      await mutate('gifts.launch', {
        title: title.trim(),
        face,
        days,
        products: [...productIds].sort(),
        personIds: [...personIds].sort(),
        brokerConfirmed: brokerRequired && confirmed,
      });
      setTitle('');
      setProductIds([]);
      setPersonIds([]);
      setConfirmed(false);
      setReview(false);
    });
  }

  return (
    <section className="wg-card">
      <h2>Create gift offers</h2>
      <fieldset disabled={busy}>
        {!review ? (
          <>
            <label className="wg-field">
              Campaign title
              <input maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <Dollars
              label="Value per gift"
              value={amount}
              change={(value) => {
                setAmount(value);
                setCatalog(undefined);
                setProductIds([]);
              }}
            />
            <label className="wg-field">
              Offer duration
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[15, 30, 60].map((day) => (
                  <option key={day} value={day}>
                    {day} days
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>Reward products</legend>
              <p>Choose one product, or give recipients a choice of 5 to 10.</p>
              <button className="btn secondary" disabled={!face} onClick={loadCatalog}>
                {catalog ? 'Refresh products' : 'Load products for this value'}
              </button>
              {catalog &&
                (catalog.length === 0 ? (
                  <p>No products are available for this amount.</p>
                ) : (
                  <div className="wg-choices">
                    {catalog.map((product) => (
                      <label key={product.id}>
                        <input
                          type="checkbox"
                          checked={productIds.includes(product.id)}
                          disabled={productIds.length >= 10 && !productIds.includes(product.id)}
                          onChange={() => setProductIds(toggle(productIds, product.id))}
                        />
                        {product.name}
                      </label>
                    ))}
                  </div>
                ))}
            </fieldset>
            <fieldset>
              <legend>Recipients</legend>
              <label>
                Find eligible recipients
                <input
                  type="search"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setOffset(0);
                  }}
                />
              </label>
              <p role="status">
                {people.length} selected · {filtered.length} matching recipients
              </p>
              <div className="wg-choices">
                {page.map((person) => (
                  <label key={person.id}>
                    <input
                      type="checkbox"
                      checked={personIds.includes(person.id)}
                      disabled={personIds.length >= 1000 && !personIds.includes(person.id)}
                      onChange={() => setPersonIds(toggle(personIds, person.id))}
                    />
                    {person.label}
                  </label>
                ))}
              </div>
              {filtered.length > pageSize && (
                <div className="wg-actions">
                  <button
                    className="btn secondary"
                    disabled={!start}
                    onClick={() => setOffset(start - pageSize)}
                  >
                    Previous recipients
                  </button>
                  <span>
                    {start + 1}–{start + page.length} of {filtered.length}
                  </span>
                  <button
                    className="btn secondary"
                    disabled={start + pageSize >= filtered.length}
                    onClick={() => setOffset(start + pageSize)}
                  >
                    Next recipients
                  </button>
                </div>
              )}
              {personIds.length > 0 && (
                <button className="btn secondary" onClick={() => setPersonIds([])}>
                  Clear selection
                </button>
              )}
            </fieldset>
            {brokerRequired && (
              <label className="wg-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                My broker has approved these thank-you gifts.
              </label>
            )}
            <p className="wg-review">
              Credit to reserve {money(required)} · Available {money(status.available)}
            </p>
            {required > status.available && (
              <p role="status">There is insufficient available credit for these offers.</p>
            )}
            <button className="btn" disabled={!ready} onClick={() => setReview(true)}>
              Review offers
            </button>
          </>
        ) : (
          <>
            <h3>Review funded offers</h3>
            <p>
              <strong>{title}</strong> · {days} days · {money(face)} each
            </p>
            <p>Reward choices · {products.map((p) => p.name).join(', ')}</p>
            <details>
              <summary>Selected recipients ({people.length})</summary>
              <ul>
                {people.map((p) => (
                  <li key={p.id}>{p.label}</li>
                ))}
              </ul>
            </details>
            <p className="wg-review">
              Reserve {money(required)} for {people.length} recipients. This creates funded offers.
              Delivery is a separate step.
            </p>
            {!ready && (
              <p role="alert">
                Review the current available credit and recipient selection before continuing.
              </p>
            )}
            <div className="wg-actions">
              <button className="btn secondary" onClick={() => setReview(false)}>
                Edit offers
              </button>
              <button className="btn" disabled={!ready} onClick={launch}>
                Create funded offers
              </button>
            </div>
          </>
        )}
      </fieldset>
    </section>
  );
}

function GiftAlerts({
  view,
  busy,
  save,
}: {
  view: GiftNotificationView;
  busy: boolean;
  save: (prefs: GiftAlertPreferences) => void;
}) {
  const [draft, setDraft] = useState(view.preferences);
  const changed =
    draft.lowCredit !== view.preferences.lowCredit ||
    draft.campaignEnded !== view.preferences.campaignEnded;
  const labels = {
    queued: 'Email pending',
    captured: 'Email captured for testing',
    accepted: 'Email accepted by provider',
    review: 'Email needs review',
    suppressed: 'Email suppressed',
  };
  return (
    <section className="wg-card">
      <h2>Owner gift alerts</h2>
      {view.notices.length ? (
        <ul>
          {view.notices.map((n) => (
            <li key={n.id}>
              <time dateTime={n.at}>{new Date(n.at).toLocaleString()}</time> · {n.message} ·{' '}
              {labels[n.email]}
            </li>
          ))}
        </ul>
      ) : (
        <p>No owner gift alerts yet.</p>
      )}
      <fieldset disabled={busy}>
        <legend>Workspace alert preferences</legend>
        <p>
          These preferences apply to in-app alerts and owner email. Disputes, failed payments and account
          holds always create alerts.
        </p>
        <label className="wg-check">
          <input
            type="checkbox"
            checked={draft.lowCredit}
            onChange={(e) => setDraft({ ...draft, lowCredit: e.target.checked })}
          />
          Low gift credit
        </label>
        <label className="wg-check">
          <input
            type="checkbox"
            checked={draft.campaignEnded}
            onChange={(e) => setDraft({ ...draft, campaignEnded: e.target.checked })}
          />
          Campaign ended with unused credit returned
        </label>
        <button className="btn secondary" disabled={!changed} onClick={() => save(draft)}>
          Save alert preferences
        </button>
      </fieldset>
    </section>
  );
}

function CreditPurchase({
  busy,
  run,
  mutate,
  active,
}: {
  busy: boolean;
  run: Run;
  mutate: Mutation;
  active: () => boolean;
}) {
  const [value, setValue] = useState('50.00');
  const face = parseDollars(value);
  const fee = Math.round(face / 10);
  return (
    <section className="wg-card">
      <h2>Buy gift credit</h2>
      <fieldset disabled={busy}>
        <Dollars label="Gift credit to buy" value={value} change={setValue} />
        {face >= 100 ? (
          <dl className="wg-list wg-review">
            <div>
              <dt>Gift credit</dt>
              <dd>{money(face)}</dd>
            </div>
            <div>
              <dt>Purchase fee (10%)</dt>
              <dd>{money(fee)}</dd>
            </div>
            <div>
              <dt>Total at Stripe</dt>
              <dd>
                <strong>{money(face + fee)}</strong>
              </dd>
            </div>
          </dl>
        ) : (
          <p>Enter $1.00 to $100,000.00, with up to two decimal places.</p>
        )}
        <button
          className="btn"
          disabled={face < 100}
          onClick={() =>
            void run(async () => {
              await mutate<{ url: string | null }>('gifts.purchase', { face }, ({ url }) => {
                if (!url)
                  throw new Error('This checkout is unavailable. Check the purchase status below.');
                const checkout = new URL(url);
                if (
                  checkout.origin !== 'https://checkout.stripe.com' ||
                  checkout.username ||
                  checkout.password
                ) {
                  throw new Error(
                    'Stripe checkout could not be opened. Check purchase history before retrying.',
                  );
                }
                if (active()) window.location.assign(checkout.href);
              });
            }, false)
          }
        >
          Continue to Stripe{face >= 100 ? ' · ' + money(face + fee) : ''}
        </button>
      </fieldset>
    </section>
  );
}

function OfferLink({
  api,
  brandId,
  status,
  busy,
  run,
}: Props & { status: Status; busy: boolean; run: Run }) {
  const [campaignId, setCampaign] = useState('');
  const [personId, setPerson] = useState('');
  const [path, setPath] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const prefix = useId();
  const campaign = status.campaigns.find((c) => c.id === campaignId);
  const byId = new Map(status.people.map((p) => [p.id, p.label]));
  const recipients: Person[] = campaign?.recipients
    ? campaign.recipients
        .filter((p) => p.state !== 'expired')
        .map((p) => ({
          id: p.id,
          label: (byId.get(p.id) ?? p.id) + ' · ' + p.state,
        }))
    : status.people;
  const matches = recipients.filter((p) => p.label.toLowerCase().includes(search.trim().toLowerCase()));
  const start = Math.min(offset, Math.max(0, Math.floor((matches.length - 1) / pageSize) * pageSize));
  const current = campaign && matches.slice(start, start + pageSize).some((p) => p.id === personId);
  function clearLink() {
    setPerson('');
    setPath('');
  }
  return (
    <section className="wg-card">
      <h2>Recipient link</h2>
      <fieldset disabled={busy}>
        <label htmlFor={prefix + '-campaign'}>Gift campaign</label>
        <select
          id={prefix + '-campaign'}
          value={campaignId}
          onChange={(e) => {
            setCampaign(e.target.value);
            setSearch('');
            setOffset(0);
            clearLink();
          }}
        >
          <option value="">Choose a campaign</option>
          {status.campaigns.map((c) => (
            <option value={c.id} key={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        {campaign && recipients.length > pageSize && (
          <label>
            Find a gift recipient
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
                clearLink();
              }}
            />
          </label>
        )}
        <label htmlFor={prefix + '-person'}>Gift recipient</label>
        <select
          id={prefix + '-person'}
          disabled={!campaign}
          value={personId}
          onChange={(e) => {
            setPerson(e.target.value);
            setPath('');
          }}
        >
          <option value="">Choose a recipient</option>
          {campaign &&
            matches.slice(start, start + pageSize).map((p) => (
              <option value={p.id} key={p.id}>
                {p.label}
              </option>
            ))}
        </select>
        {campaign && matches.length > pageSize && (
          <div className="wg-actions">
            <button
              className="btn secondary"
              disabled={!start}
              onClick={() => {
                setOffset(start - pageSize);
                clearLink();
              }}
            >
              Previous link recipients
            </button>
            <button
              className="btn secondary"
              disabled={start + pageSize >= matches.length}
              onClick={() => {
                setOffset(start + pageSize);
                clearLink();
              }}
            >
              Next link recipients
            </button>
          </div>
        )}
        <button
          className="btn secondary"
          disabled={!current}
          onClick={() =>
            void run(async () => {
              setPath('');
              const result = await api.call<{ path: string }>('gifts.link', {
                brandId,
                campaignId,
                personId,
              });
              const url = new URL(result.path, window.location.origin);
              if (
                url.origin !== window.location.origin ||
                url.pathname !== '/workspace-gift.html' ||
                url.username ||
                url.password ||
                url.search ||
                !url.hash
              ) {
                throw new Error('The recipient link could not be opened.');
              }
              setPath(url.pathname + url.hash);
            }, false)
          }
        >
          Get recipient link
        </button>
      </fieldset>
      {current && path && (
        <a href={path} target="_blank" rel="noreferrer noopener">
          Open private recipient link
        </a>
      )}
    </section>
  );
}

/** Checkout returns select a view. Only a matching server purchase can be reconciled. */
export function workspaceGiftReturnUrl(location: Pick<Location, 'pathname' | 'search'>) {
  const params = new URLSearchParams(location.search);
  if (location.pathname !== '/' || params.getAll('gifts').length !== 1 || params.get('gifts') !== '1')
    return null;
  const result = new URLSearchParams({ gifts: '1' });
  for (const key of ['brand', 'purchase']) {
    const value = params.get(key);
    if (
      value &&
      params.getAll(key).length === 1 &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
    ) {
      result.set(key, value.toLowerCase());
    }
  }
  return '/?' + result;
}

export function WorkspaceGifts({ api, brandId }: Props) {
  return <GiftDashboard key={brandId} api={api} brandId={brandId} />;
}

function GiftDashboard({ api, brandId }: Props) {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [closeReview, setCloseReview] = useState(false);
  const mounted = useRef(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const keys = useRef(new Map<string, string>());
  const returned = new URLSearchParams(window.location.search);
  const returnedId = returned.get('gifts') === '1' ? returned.get('purchase') : null;

  const refresh = useCallback(async () => {
    const ticket = ++generation.current;
    try {
      const next = await api.call<Status>('gifts.status', { brandId });
      if (mounted.current && ticket === generation.current) setStatus(next);
    } catch (cause) {
      if (mounted.current && ticket === generation.current) {
        setError(errorText(cause));
        setStatus(undefined);
      }
    }
  }, [api, brandId]);
  useEffect(() => {
    mounted.current = true;
    const update = () => {
      if (!lock.current && document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    window.addEventListener('pageshow', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      mounted.current = false;
      generation.current++;
      window.removeEventListener('pageshow', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [refresh]);

  async function mutate<T>(
    name: Parameters<Mutation>[0],
    input: Record<string, unknown>,
    accept?: (result: T) => void,
  ): Promise<T> {
    const signature = JSON.stringify([brandId, name, input]);
    const key = keys.current.get(signature) ?? operationKey();
    keys.current.set(signature, key);
    const result = await api.call<T>(name, { brandId, ...input, operationKey: key });
    accept?.(result);
    keys.current.delete(signature);
    return result;
  }
  const run: Run = async (action, refreshAfter = true) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      if (mounted.current) {
        setError(errorText(cause));
        if (!refreshAfter) await refresh();
      }
    } finally {
      if (refreshAfter && mounted.current) await refresh();
      if (mounted.current) setBusy(false);
      lock.current = false;
    }
  };
  const canManage = status?.canManage === true;
  const canCreate = canManage && !status?.closed && status?.eligibility?.eligible === true;
  const reconcile = (purchaseId: string) =>
    void run(async () => {
      await mutate('gifts.reconcile', { purchaseId });
    });

  return (
    <section className="workspace-gifts" aria-label="Workspace gifts">
      <div className="wg-actions">
        <h1 className="page-heading">Workspace gifts</h1>
        <button className="btn secondary" disabled={busy} onClick={() => void run(refresh, false)}>
          Refresh gift credit balances
        </button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!status ? (
        <p role="status">{error ? 'Gift status is unavailable.' : 'Loading gift status…'}</p>
      ) : (
        <>
          {returnedId && (
            <div className="notice" role="status">
              Back from Stripe. Check the purchase against Stripe to confirm its payment status.
              {canManage && status.purchases.some((p) => p.id === returnedId) && (
                <div>
                  <button
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => reconcile(returnedId)}
                  >
                    Check returned purchase
                  </button>
                </div>
              )}
            </div>
          )}
          <section className="wg-card">
            <h2>Gift credit</h2>
            <dl className="wg-balances">
              {Object.entries({
                Available: status.available,
                Reserved: status.reserved,
                'Total credit': status.available + status.reserved,
                Spent: status.spent,
                Refunded: status.refunded,
              }).map(([label, cents]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{money(cents)}</dd>
                </div>
              ))}
            </dl>
            <a href="#workspace-gift-ledger">View credit ledger</a>
          </section>
          {status.closed && (
            <p className="notice">
              Workspace gifting is closed. Purchases and refund activity appear below.
            </p>
          )}
          {!canManage && <p className="notice">You have read-only access to workspace gifts.</p>}
          {status.eligibility?.eligible === false && (
            <div className="notice">
              <strong>New gift offers are on hold.</strong>
              <ul>
                {status.eligibility.reasons.map((reason, i) => (
                  <li key={i}>{holdReasons[reason] ?? reason}</li>
                ))}
              </ul>
            </div>
          )}
          {Boolean(status.pending) && <p role="status">Pending gift activity · {status.pending}</p>}
          {Boolean(status.alerts?.length) && (
            <ul aria-label="Gift alerts" className="notice">
              {status.alerts?.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          )}
          {canManage && status.ownerNotifications && (
            <GiftAlerts
              key={JSON.stringify(status.ownerNotifications.preferences)}
              view={status.ownerNotifications}
              busy={busy}
              save={(prefs) =>
                void run(async () => {
                  await mutate('gifts.notificationPreferences', prefs);
                })
              }
            />
          )}
          {canManage && !status.closed && (
            <div className="wg-grid">
              <CreditPurchase busy={busy} run={run} mutate={mutate} active={() => mounted.current} />
              {canCreate && (
                <CampaignForm
                  api={api}
                  brandId={brandId}
                  busy={busy}
                  status={status}
                  run={run}
                  mutate={mutate}
                />
              )}
            </div>
          )}
          <section className="wg-card">
            <h2>Purchases</h2>
            {status.purchases.length === 0 ? (
              <p>No gift credit purchases.</p>
            ) : (
              <ul>
                {status.purchases.map((p) => (
                  <li key={p.id}>
                    {money(p.face)} credit · {money(p.total - p.face)} fee · {money(p.total)} total ·{' '}
                    {p.state}
                    {canManage && p.state === 'checkout' && (
                      <div>
                        <button
                          className="btn secondary"
                          disabled={busy}
                          onClick={() => reconcile(p.id)}
                        >
                          Check payment with Stripe
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="wg-card">
            <h2>Campaign results</h2>
            {status.campaigns.length === 0 ? (
              <p>No funded offers yet.</p>
            ) : (
              <>
                <p>Claims count gifts purchased for recipients. Store redemption is unobserved.</p>
                {status.campaigns.map((c) => (
                  <article key={c.id}>
                    <h3>{c.title}</h3>
                    <p>
                      {c.offered} offered · {c.claimed} claimed (
                      {c.offered ? Math.round((100 * c.claimed) / c.offered) : 0}%) · {c.expired} expired
                      {c.expiresAt && (
                        <>
                          {' '}
                          · Expires{' '}
                          <time dateTime={c.expiresAt}>
                            {new Date(c.expiresAt).toLocaleDateString()}
                          </time>
                        </>
                      )}
                    </p>
                    <p>
                      {money(c.reserved)} reserved · {money(c.spent)} spent · {money(c.released)}{' '}
                      released
                      {c.fees !== undefined && ' · ' + money(c.fees) + ' fees'}
                    </p>
                    <GiftRecipientReport campaign={c}/>
                  </article>
                ))}
              </>
            )}
          </section>
          {canManage && status.campaigns.length > 0 && (
            <OfferLink api={api} brandId={brandId} status={status} busy={busy} run={run} />
          )}
          <section className="wg-card" id="workspace-gift-ledger">
            <h2>Credit ledger</h2>
            {status.ledger.length === 0 ? (
              <p>No ledger entries.</p>
            ) : (
              <ul>
                {status.ledger.map((entry, i) => (
                  <li key={i}>
                    <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time> ·{' '}
                    {entry.kind.replaceAll('_', ' ')} · {money(entry.amount)}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {canManage && !status.closed && (
            <section className="wg-card">
              <h2>Close workspace gifting</h2>
              {closeReview ? (
                <>
                  <p className="wg-review">
                    Close gifting for this workspace and request a refund of unused credit plus its share
                    of the purchase fee. Current available credit is {money(status.available)} with{' '}
                    {money(status.reserved)} reserved. Refunds appear after verification.
                  </p>
                  <div className="wg-actions">
                    <button
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => setCloseReview(false)}
                    >
                      Keep gifting open
                    </button>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await mutate('gifts.close', {});
                          setCloseReview(false);
                        })
                      }
                    >
                      Confirm closure and request refund
                    </button>
                  </div>
                </>
              ) : (
                <button className="btn secondary" disabled={busy} onClick={() => setCloseReview(true)}>
                  Review gifting closure
                </button>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
