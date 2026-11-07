import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Company, CompanyBrand, CompanyDirectory } from '../shared/companies.js';
import type { CommandName } from '../shared/contracts.js';
import { operationKey, type Api } from './api.js';
import { CompanyUsage } from './CompanyUsage.js';
import { CompanyNameForm } from './CompanyNameForm.js';
import './companies.css';

type Change = (name: CommandName, input: Record<string, unknown>, status: string) => Promise<void>;
function MoveBrand({
  brand,
  companyId,
  companies,
  change,
}: {
  brand: CompanyBrand;
  companyId: string;
  companies: Company[];
  change: Change;
}) {
  const [target, setTarget] = useState(companyId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const key = useRef(operationKey()),
    id = useId();
  async function move(event: FormEvent) {
    event.preventDefault();
    if (busy || target === companyId) return;
    setBusy(true);
    setError('');
    try {
      await change(
        'brand.move',
        { id: brand.id, companyId: target, operationKey: key.current },
        'Brand moved.',
      );
      key.current = operationKey();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The brand could not be moved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="company-form" onSubmit={move}>
      <label htmlFor={id}>Company for {brand.name}</label>
      <div>
        <select
          id={id}
          value={target}
          disabled={busy}
          onChange={(e) => {
            setTarget(e.target.value);
            key.current = operationKey();
            setError('');
          }}
        >
          {companies.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button className="btn secondary" type="submit" disabled={target === companyId || busy}>
          Move brand
        </button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
    </form>
  );
}

export function Companies({ api, onChanged }: { api: Api; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<CompanyDirectory>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const titleId = useId();
  useEffect(() => {
    let current = true;
    api
      .call<CompanyDirectory>('company.list', {})
      .then((value) => {
        if (current) {
          setData(value);
          setError('');
        }
      })
      .catch((e) => {
        if (current) setError(e instanceof Error ? e.message : 'The company directory could not be loaded.');
      });
    return () => {
      current = false;
    };
  }, [api, reload]);
  const change: Change = async (name, input, status) => {
    await api.call(name, input);
    setNotice(status);
    setReload((v) => v + 1);
    try {
      await onChanged();
    } catch {
      setError('Your change was saved. Refresh the workspace to see its latest brands.');
    }
  };
  return (
    <section className="card companies-panel" aria-labelledby={titleId}>
      <h2 id={titleId}>Companies &amp; brands</h2>
      {error && (
        <div role="alert" className="notice error">
          {error}{' '}
          <button className="btn secondary" onClick={() => setReload((v) => v + 1)}>
            Retry directory
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="notice success">
          {notice}
        </p>
      )}
      {!data && !error && <p role="status">Loading companies…</p>}
      {data && (
        <>
          <p>
            {data.planName} limits apply across this workspace. Each sending brand keeps its own contacts and
            sender settings.
          </p>
          <CompanyUsage companies={data.companies.length} brands={data.brandCount} limits={data.limits} />
          {data.companies.length < data.limits.companies && (
            <details>
              <summary>Add company</summary>
              <CompanyNameForm
                label="New company name"
                action="Add company"
                onSave={(name, key) =>
                  change('company.create', { name, operationKey: key }, 'Company added.')
                }
              />
            </details>
          )}
          {data.companies.map((company) => (
            <article className="company-record" key={company.id}>
              <h3>{company.name}</h3>
              <details>
                <summary>Manage company</summary>
                <CompanyNameForm
                  key={company.name}
                  label={'Name for ' + company.name}
                  action="Rename company"
                  initial={company.name}
                  onSave={(name, key) =>
                    change('company.rename', { id: company.id, name, operationKey: key }, 'Company renamed.')
                  }
                />
              </details>
              {company.brands.length ? (
                <ul className="company-brands">
                  {company.brands.map((brand) => (
                    <li key={brand.id}>
                      <details>
                        <summary>{brand.name}</summary>
                        <CompanyNameForm
                          key={brand.name}
                          label={'Brand name for ' + brand.name}
                          action="Rename brand"
                          initial={brand.name}
                          onSave={(name, key) =>
                            change(
                              'brand.rename',
                              { id: brand.id, name, operationKey: key },
                              'Brand renamed.',
                            )
                          }
                        />
                        {data.companies.length > 1 && (
                          <MoveBrand
                            brand={brand}
                            companyId={company.id}
                            companies={data.companies}
                            change={change}
                          />
                        )}
                      </details>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>This company has no brands yet.</p>
              )}
              {data.brandCount < data.limits.brands && (
                <details>
                  <summary>Add a brand to {company.name}</summary>
                  <CompanyNameForm
                    label={'New brand name for ' + company.name}
                    action="Add brand"
                    onSave={(name, key) =>
                      change(
                        'brand.create',
                        { companyId: company.id, name, operationKey: key },
                        'Brand added.',
                      )
                    }
                  />
                </details>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
