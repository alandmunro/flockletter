import { useEffect, useId, useState } from 'react';
import { operationKey } from './api.js';
import type { Api } from './api.js';
import type { Brand, IntakeStatus } from '../shared/contracts.js';

type ConfigureIntent = { enabled: boolean; key: string };
type CredentialIntent = { key: string };
type IssuedConnection = { token?: string; secretAlreadyIssued: boolean };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function IntakePanel({
  api,
  brand,
  onIssued,
}: {
  api: Api;
  brand: Brand;
  onIssued: () => Promise<void>;
}) {
  const headingId = useId();
  const [status, setStatus] = useState<IntakeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [configureIntent, setConfigureIntent] = useState<ConfigureIntent | null>(null);
  const [credentialIntent, setCredentialIntent] = useState<CredentialIntent | null>(null);
  const [configureBusy, setConfigureBusy] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);

  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  useEffect(() => {
    setConfigureIntent(null);
    setCredentialIntent(null);
    setIssuedToken(null);
  }, [brand.id]);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError(null);

    api
      .call<IntakeStatus>('intake.status', { brandId: brand.id })
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((err: unknown) => {
        if (active) setError(errorText(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [api, brand.id, reloadNonce]);

  useEffect(() => {
    if (status && configureIntent && status.enabled === configureIntent.enabled) {
      setConfigureIntent(null);
    }
  }, [status, configureIntent]);

  useEffect(() => {
    if (status && !status.enabled) {
      setCredentialIntent(null);
    }
  }, [status]);

  async function changeEnabled(target: boolean) {
    if (loading || configureBusy || credentialBusy) return;
    if (!status?.ready && target === true) return;

    const nextIntent =
      configureIntent && configureIntent.enabled === target
        ? configureIntent
        : { enabled: target, key: operationKey() };

    setConfigureIntent(nextIntent);
    setConfigureBusy(true);
    setError(null);

    try {
      await api.call<unknown>('intake.configure', {
        brandId: brand.id,
        enabled: target,
        operationKey: nextIntent.key,
      });

      setConfigureIntent(null);
      setReloadNonce((value) => value + 1);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setConfigureBusy(false);
    }
  }

  async function issueCredential() {
    if (loading || configureBusy || credentialBusy) return;
    if (!status?.enabled || !status.ready || issuedToken) return;

    const nextIntent = credentialIntent ?? { key: operationKey() };

    setCredentialIntent(nextIntent);
    setCredentialBusy(true);
    setError(null);

    try {
      const created = await api.call<IssuedConnection>('connection.create', {
        operationKey: nextIntent.key,
        name: 'Storefront subscriber intake',
        scopes: ['subscriber:signup'],
        brandIds: [brand.id],
        expiresInDays: 30,
      });

      setCredentialIntent(null);
      setIssuedToken(created.token ?? null);
      await onIssued();
      if (!created.token)
        setError(
          'That credential was already issued. Revoke it in Your connections before issuing a replacement.',
        );
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setCredentialBusy(false);
    }
  }

  const busy = loading || configureBusy || credentialBusy;

  return (
    <section className="card" aria-busy={busy} aria-labelledby={headingId}>
      <h2 id={headingId}>Subscriber intake for {brand.name}</h2>

      {error ? (
        <div className="notice error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="btn secondary"
            onClick={() => setReloadNonce((value) => value + 1)}
          >
            Refresh status
          </button>
        </div>
      ) : null}

      {loading && !status ? (
        <p>Loading intake settings…</p>
      ) : status ? (
        <>
          <dl className="intake-metrics">
            <dt>Configured source</dt>
            <dd>{status.sourceDomain || 'None'}</dd>

            <dt>Confirmation mode</dt>
            <dd>{status.mode === 'capture' ? 'Capture (test)' : status.mode === 'live' ? 'Live' : 'Off'}</dd>

            <dt>Ready</dt>
            <dd>{status.ready ? 'Yes' : 'No'}</dd>

            <dt>Pending</dt>
            <dd>{status.counts.pending}</dd>

            <dt>Confirmed</dt>
            <dd>{status.counts.confirmed}</dd>

            <dt>Queued</dt>
            <dd>{status.counts.queued}</dd>

            <dt>Failed</dt>
            <dd>{status.counts.failed}</dd>

            <dt>Unknown</dt>
            <dd>{status.counts.unknown}</dd>
            <dt>Provider accepted</dt>
            <dd>{status.counts.delivered}</dd>
            <dt>Test captures</dt>
            <dd>{status.counts.captured}</dd>
            <dt>Requests accepted</dt>
            <dd>{status.counts.accepted}</dd>
            <dt>Replays</dt>
            <dd>{status.counts.replays}</dd>
            <dt>Rejected / rate limited</dt>
            <dd>
              {status.counts.rejected} / {status.counts.throttled}
            </dd>
          </dl>

          {loading ? <p>Updating…</p> : null}
          {!status.ready && (
            <p className="help">
              {status.sourceDomain
                ? 'Start the configured confirmation worker to accept signups.'
                : 'Configure the brand, source domain and confirmation transport before enabling intake.'}
            </p>
          )}

          <div>
            {status.enabled ? (
              <button
                type="button"
                className="btn secondary"
                disabled={busy}
                aria-busy={configureBusy}
                onClick={() => {
                  void changeEnabled(false);
                }}
              >
                Disable intake
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={busy || !status.ready}
                aria-busy={configureBusy}
                onClick={() => {
                  void changeEnabled(true);
                }}
              >
                Enable intake
              </button>
            )}
          </div>

          {issuedToken ? (
            <div className="notice success">
              <p role="status">
                Save this credential in the storefront server’s secret settings. It is shown once.
              </p>
              <pre className="token-output">{issuedToken}</pre>
              <div>
                <button type="button" className="btn secondary" onClick={() => setIssuedToken(null)}>
                  Dismiss
                </button>
                <a href="#workspace-connections">Manage credentials</a>
              </div>
            </div>
          ) : (
            <div>
              <button
                type="button"
                className="btn secondary"
                disabled={busy || !status.enabled || !status.ready}
                aria-busy={credentialBusy}
                onClick={() => {
                  void issueCredential();
                }}
              >
                Issue intake credential
              </button>
              <p>Use the Connections list to revoke issued credentials.</p>
            </div>
          )}
        </>
      ) : error ? null : (
        <p>No intake status is available.</p>
      )}
    </section>
  );
}
