import { useCallback, useEffect, useRef, useState } from 'react';
import type { Brand, CommandName } from '../shared/contracts.js';
import type { InfrastructureStatus } from '../shared/customer-infrastructure.js';
import { operationKey, type Api } from './api.js';

export function InfrastructureSetup({ api, brands }: { api: Api; brands: Brand[] }) {
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const [data, setData] = useState<InfrastructureStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<Map<string, string>>(new Map());

  const selected=useRef(brandId),request=useRef(0);
  selected.current=brandId;
  const reload = useCallback(async(id:string)=>{
    if(!id)return;
    const current=++request.current;setBusy(true);setError('');setData(undefined);
    try{
      const value=await api.call<InfrastructureStatus>('infrastructure.status',{brandId:id});
      if(current===request.current&&selected.current===id)setData(value);
    }catch(error){if(current===request.current&&selected.current===id)setError(error instanceof Error?error.message:'Refresh failed.');}
    finally{if(current===request.current&&selected.current===id)setBusy(false);}
  },[api]);
  useEffect(()=>{
    void reload(brandId);
    return()=>{request.current++;};
  },[reload,brandId]);

  async function act(name: CommandName, input: Record<string, unknown>) {
    const signature = JSON.stringify([name, input]);
    let key = pending.current.get(signature);
    if (!key) {
      key = operationKey();
      pending.current.set(signature, key);
    }
    setBusy(true);
    setError('');
    try {
      const result = await api.call<InfrastructureStatus>(name, { ...input, operationKey: key });
      pending.current.delete(signature);
      setData(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
    } finally {
      setBusy(false);
    }
  }

  const profile = data?.profile ?? null;

  return (
    <section className="card" aria-labelledby="infra-title" style={{ overflowWrap: 'anywhere' }}>
      <h2 id="infra-title">Sender infrastructure</h2>

      {brands.length > 0 && <label htmlFor="infra-brand">Brand</label>}
      {brands.length > 0 && (
        <select id="infra-brand" disabled={busy} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      )}

      {error && <p role="alert">{error}</p>}
      {!data && !error && brandId && <p role="status">Loading infrastructure status…</p>}

      {data && (
        <>
          <p>
            Mode: <strong>{data.mode}</strong> · Provider configured: {data.providerConfigured ? 'yes' : 'no'}{' '}
            · Budget approval required: {data.budgetApprovalRequired ? 'yes' : 'no'} · External adapter:{' '}
            {data.externalChangesEnabled ? 'enabled' : 'disabled'}
          </p>

          {!profile && (
            <p>
              No legal sender profile saved. Save one on the Delivery screen before configuring
              infrastructure.
            </p>
          )}

          {profile && (
            <div className="card">
              <h3>Sender profile</h3>
              <p>Domain: {profile.fromEmail.split('@')[1]}</p>
              <p>From email: {profile.fromEmail}</p>
              <p>Revision: {profile.revision}</p>
            </div>
          )}

          {data.mode === 'capture' && (
            <p role="note">
              Capture mode uses DNS records under an .invalid domain. These are unusable for live sending and
              exist only to exercise the provisioning flow. Do not add these example records to your DNS.
            </p>
          )}

          {data.mode === 'aws' && !data.providerConfigured && (
            <p role="alert">AWS provider is not yet configured on the server. Contact an administrator.</p>
          )}

          <div className="actions">
            {profile && data.mode !== 'off' && (
              <button
                className="btn"
                disabled={busy || !data.eligible}
                onClick={() =>
                  void act('infrastructure.review', {
                    brandId,
                    senderRevision: profile.revision,
                  })
                }
              >
                Review infrastructure plan
              </button>
            )}
            <button
              className="btn secondary"
              disabled={busy || !brandId}
              onClick={() =>
                void reload(brandId).catch((e: unknown) =>
                  setError(e instanceof Error ? e.message : 'Refresh failed.'),
                )
              }
            >
              Refresh status
            </button>
          </div>

          {data.plans.length === 0 && profile && (
            <p>No infrastructure plans yet. Review the plan to generate one.</p>
          )}

          {data.plans.map((plan) => (
            <article key={plan.id} className="card">
              <h3>
                Plan {plan.state.replaceAll('_', ' ')} · v{plan.version}
              </h3>
              <p>Domain: {plan.domain}</p>
              <p>From email: {plan.fromEmail}</p>
              <p>Sender revision: {plan.senderRevision}</p>
              <p className="help">
                Last recorded result: {new Date(plan.updatedAt).toLocaleString()}. Live readiness is checked
                again before sending.
              </p>
              {plan.reason && <p>Reason: {plan.reason.replaceAll('_', ' ')}</p>}
              {plan.state === 'held' && !plan.retryable && (
                <p>
                  An attempted step needs operator review. Preserve its evidence; cancel future work and
                  review a fresh plan after the cause is resolved.
                </p>
              )}

              {plan.dns.length > 0 && (
                <>
                  <h4>DNS records</h4>
                  <ul>
                    {plan.dns.map((d, i) => (
                      <li key={i}>
                        {d.type} · {d.name} → {d.value}
                        {typeof d.priority === 'number' ? ` (priority ${d.priority})` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {plan.resources && (
                <details>
                  <summary>Resource references for support</summary>
                  <p>Tenant: {plan.resources.tenant}</p>
                  <p>Configuration set: {plan.resources.configurationSet}</p>
                  <p>Sender identity: {plan.resources.identityArn}</p>
                  <p>Feedback topic: {plan.resources.topicArn}</p>
                </details>
              )}

              <p className="help">
                Stopping future setup preserves its evidence and does not delete resources already created.
              </p>
              <div className="actions">
                {plan.state === 'reviewed' && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void act('infrastructure.approve', {
                        brandId,
                        id: plan.id,
                        expectedVersion: plan.version,
                        reviewDigest: plan.reviewDigest,
                      })
                    }
                  >
                    Approve reviewed plan
                  </button>
                )}

                {['queued', 'provisioning', 'awaiting_dns', 'uncertain'].includes(plan.state) && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void act('infrastructure.process', {
                        brandId,
                        id: plan.id,
                      })
                    }
                  >
                    Process / reconcile
                  </button>
                )}

                {plan.retryable && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void act('infrastructure.retry', {
                        brandId,
                        id: plan.id,
                        expectedVersion: plan.version,
                      })
                    }
                  >
                    Retry held job
                  </button>
                )}

                {['reviewed', 'queued', 'held', 'uncertain'].includes(plan.state) && (
                  <button
                    className="btn secondary"
                    disabled={busy}
                    onClick={() =>
                      void act('infrastructure.cancel', {
                        brandId,
                        id: plan.id,
                        expectedVersion: plan.version,
                      })
                    }
                  >
                    Stop future setup
                  </button>
                )}
              </div>
            </article>
          ))}

          <p className="help">
            Approval records a server-owned plan. Live resource changes also require independent operator
            configuration and a reserved provisioning allowance.
          </p>
        </>
      )}
    </section>
  );
}
