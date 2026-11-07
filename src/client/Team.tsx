import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Brand } from '../shared/contracts.js';
import type { DirectoryMember, TeamPage, TeamRole } from '../shared/team.js';
import { operationKey, type Api } from './api.js';
import { accountSuffix, brandLabel, TeamRoster } from './TeamRoster.js';
import './team.css';

type GrantCommand = 'team.grant' | 'team.revoke';
type EditMember = (
  command: GrantCommand,
  member: DirectoryMember,
  fields?: { permission: TeamRole; brandIds: string[] },
) => Promise<void>;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'The team request could not be completed. Try again.';

export function Team({ api, brands }: { api: Api; brands: Brand[] }) {
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (notice) status.current?.focus();
  }, [notice, revision]);
  const pending = useRef(new Map<string, { signature: string; key: string }>());
  const change: EditMember = async (command, member, fields) => {
    const input = { userId: member.userId, ...fields };
    const signature = JSON.stringify(input);
    const slot = command + ':' + member.userId;
    const previous = pending.current.get(slot);
    const key = previous?.signature === signature ? previous.key : operationKey();
    pending.current.set(slot, { signature, key });
    await api.call(command, { ...input, operationKey: key });
    // A confirmed opposite change ends previous attempts for this member. A future re-grant must be new.
    pending.current.delete('team.grant:' + member.userId);
    pending.current.delete('team.revoke:' + member.userId);
    setNotice(
      command === 'team.grant'
        ? 'Brand access saved for ' + member.name + '.'
        : 'Flockletter brand access removed for ' + member.name + '.',
    );
    setRevision((n) => n + 1);
  };
  function navigate(next: number) {
    setNotice('');
    setOffset(next);
  }
  return (
    <>
      <h1 className="page-heading">Team</h1>
      <p className="page-intro">
        Clerk manages workspace membership. Choose which brands each member can use in Flockletter.
      </p>
      {notice && (
        <p role="status" ref={status} tabIndex={-1} className="notice success">
          {notice}
        </p>
      )}
      <TeamDirectory
        key={offset + ':' + revision}
        api={api}
        brands={brands}
        offset={offset}
        navigate={navigate}
        change={change}
      />
    </>
  );
}

function TeamDirectory({
  api,
  brands,
  offset,
  navigate,
  change,
}: {
  api: Api;
  brands: Brand[];
  offset: number;
  navigate: (offset: number) => void;
  change: EditMember;
}) {
  const [page, setPage] = useState<TeamPage>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<DirectoryMember>();
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!selected) returnFocus.current?.focus();
  }, [selected]);
  useEffect(() => {
    let active = true;
    api
      .call<TeamPage>('team.list', { offset })
      .then((result) => {
        if (active) setPage(result);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [api, offset, retry]);
  if (error)
    return (
      <div role="alert" className="notice error">
        {error}{' '}
        <button
          type="button"
          className="btn secondary"
          onClick={() => {
            setError('');
            setRetry((n) => n + 1);
          }}
        >
          Retry team list
        </button>
      </div>
    );
  if (!page) return <p role="status">Verifying team membership with Clerk…</p>;
  function close() {
    setSelected(undefined);
  }
  return (
    <>
      <dl className="team-seats" aria-label="Workspace seats">
        <div>
          <dt>Clerk members</dt>
          <dd>{page.total.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Plan seat limit</dt>
          <dd>{page.seats === null ? 'Unlimited' : page.seats.toLocaleString()}</dd>
        </div>
      </dl>
      {page.overLimit && (
        <p className="notice" role="status">
          This workspace exceeds its seat limit. Member access and new grants are paused until membership or
          the plan changes. Owners can still remove brand access.
        </p>
      )}
      {selected && (
        <MemberAccess
          key={selected.userId}
          member={selected}
          brands={brands}
          overLimit={page.overLimit}
          change={change}
          close={close}
        />
      )}
      <section hidden={Boolean(selected)} className="card" aria-labelledby="team-members-heading">
        <h2 id="team-members-heading">Workspace members</h2>
        <TeamRoster
          members={page.members}
          brands={brands}
          disabled={Boolean(selected)}
          onManage={(member) => {
            returnFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setSelected(member);
          }}
        />
        {(page.offset > 0 || page.offset + page.limit < page.total) && (
          <nav className="actions team-pager" aria-label="Team member pages">
            <button
              type="button"
              className="btn secondary"
              disabled={page.offset === 0}
              onClick={() => navigate(Math.max(0, page.offset - page.limit))}
            >
              Previous members
            </button>
            <span>Page {Math.floor(page.offset / page.limit) + 1}</span>
            <button
              type="button"
              className="btn secondary"
              disabled={page.offset + page.limit >= page.total}
              onClick={() => navigate(page.offset + page.limit)}
            >
              Next members
            </button>
          </nav>
        )}
      </section>
    </>
  );
}

export function MemberAccess({
  member,
  brands,
  overLimit,
  change,
  close,
}: {
  member: DirectoryMember;
  brands: Brand[];
  overLimit: boolean;
  change: EditMember;
  close: () => void;
}) {
  const [permission, setPermission] = useState<TeamRole>(member.permission ?? 'viewer');
  const [chosen, setChosen] = useState<string[]>(() =>
    member.brandIds.filter((id) => brands.some((brand) => brand.id === id)),
  );
  const [reviewRemove, setReviewRemove] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const inFlight = useRef(false),
    heading = useRef<HTMLHeadingElement>(null),
    roleControl = useId();
  useEffect(() => {
    heading.current?.focus();
  }, []);
  if (member.membership === 'owner') return <p>Workspace owners have access to all workspace brands.</p>;
  const sorted = [...chosen].sort();
  const changed =
    permission !== member.permission ||
    JSON.stringify(sorted) !== JSON.stringify([...member.brandIds].sort());
  const canGrant = !overLimit && sorted.length > 0 && sorted.length <= 5 && changed;
  async function submit(command: GrantCommand) {
    if (
      inFlight.current ||
      (command === 'team.grant' && !canGrant) ||
      (command === 'team.revoke' && !reviewRemove)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await change(command, member, command === 'team.grant' ? { permission, brandIds: sorted } : undefined);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void submit('team.grant');
  }
  function selectBrand(id: string, checked: boolean) {
    setChosen((current) =>
      checked
        ? current.length >= 5 || current.includes(id)
          ? current
          : [...current, id]
        : current.filter((item) => item !== id),
    );
    setError('');
  }
  return (
    <section className="card team-member" aria-labelledby="member-access-heading">
      <h2 id="member-access-heading" ref={heading} tabIndex={-1}>
        Brand access for {member.name}
      </h2>
      <p className="help">Clerk account ending {accountSuffix(member)}</p>
      <form onSubmit={save}>
        <fieldset disabled={busy || reviewRemove || overLimit}>
          <label htmlFor={roleControl}>Flockletter role</label>
          <select
            id={roleControl}
            value={permission}
            onChange={(e) => {
              setPermission(e.target.value as TeamRole);
              setError('');
            }}
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          <p className="help">
            Viewers can read drafts and images. Editors can also edit drafts and upload images.
          </p>
          <fieldset className="team-brand-options">
            <legend>Brands for {member.name}</legend>
            <p className="help">Choose 1 to 5 brands.</p>
            {brands.map((brand) => (
              <label key={brand.id}>
                <input
                  type="checkbox"
                  checked={chosen.includes(brand.id)}
                  disabled={chosen.length >= 5 && !chosen.includes(brand.id)}
                  onChange={(e) => selectBrand(brand.id, e.target.checked)}
                />
                {brandLabel(brand, brands)}
              </label>
            ))}
            {!brands.length && <p>This workspace has no brands available.</p>}
          </fieldset>
          <button className="btn" type="submit" disabled={!canGrant || busy}>
            Save brand access
          </button>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="notice error">
          {error} Retry to check the same request.
        </p>
      )}
      {reviewRemove ? (
        <div className="team-remove">
          <p>
            Remove all Flockletter brand access for {member.name}? Their Clerk membership and seat stay in
            place.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => void submit('team.revoke')}
            >
              Confirm removal
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setReviewRemove(false);
                setError('');
              }}
            >
              Cancel removal
            </button>
          </div>
        </div>
      ) : (
        member.permission && (
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => {
              setReviewRemove(true);
              setError('');
            }}
          >
            Remove brand access
          </button>
        )
      )}
      <button type="button" className="btn secondary team-back" disabled={busy} onClick={close}>
        Back to members
      </button>
    </section>
  );
}
