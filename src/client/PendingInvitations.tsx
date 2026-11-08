import { useEffect, useState } from 'react';
import type { TeamInvitationPage } from '../shared/team.js';
import type { Api } from './api.js';
import { TeamInvite } from './TeamInvite.js';

export function PendingInvitations({ api }: { api: Api }) {
  const [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [notice, setNotice] = useState('');
  return (
    <section className="card" aria-labelledby="team-pending-heading">
      <h2 id="team-pending-heading">Pending invitations</h2>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <InvitationPage
        key={offset + ':' + revision}
        api={api}
        offset={offset}
        navigate={setOffset}
        refresh={(message = '') => {
          setNotice(message);
          setRevision((n) => n + 1);
        }}
      />
    </section>
  );
}
function InvitationPage({
  api,
  offset,
  navigate,
  refresh,
}: {
  api: Api;
  offset: number;
  navigate: (offset: number) => void;
  refresh: (message?: string) => void;
}) {
  const [page, setPage] = useState<TeamInvitationPage>(),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    api
      .call<TeamInvitationPage>('team.invitations', { offset })
      .then((result) => {
        if (current) setPage(result);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [api, offset]);
  if (failed)
    return (
      <div className="notice error" role="alert">
        Invitation and seat counts are unavailable.{' '}
        <button type="button" className="btn secondary" onClick={() => refresh()}>
          Retry invitation list
        </button>
      </div>
    );
  if (!page) return <p role="status">Checking pending invitations with Clerk…</p>;
  const occupied = page.members + page.total + (page.pilot?.reserved ?? 0);
  return (
    <>
      <p>
        {page.members.toLocaleString()} members · {page.total.toLocaleString()} pending invitations
        {!!page.pilot?.reserved && <> · {page.pilot.reserved} requests awaiting confirmation</>}
      </p>
      <p>
        {page.seats === null
          ? 'This plan has unlimited seats.'
          : occupied > page.seats
            ? 'Members and reservations exceed the ' + page.seats + '-seat limit.'
            : page.available + ' of ' + page.seats + ' seats available.'}
      </p>
      {!!page.pilot?.maximum && page.pilot.maximum !== page.seats &&
        <p>Clerk allows up to {page.pilot.maximum} members in this organization.</p>}
      {page.invitations.length ? (
        <ul className="team-invitations">
          {page.invitations.map((invitation) => (
            <li key={invitation.id}>
              <span>{invitation.email}</span>{' '}
              <small>
                Expires{' '}
                <time dateTime={invitation.expiresAt}>
                  {new Date(invitation.expiresAt).toLocaleDateString()}
                </time>
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p>{offset === 0 ? 'No pending invitations.' : 'No invitations on this page.'}</p>
      )}
      {(offset > 0 || offset + page.limit < page.total) && (
        <nav className="actions team-pager" aria-label="Invitation pages">
          <button
            type="button"
            className="btn secondary"
            disabled={!offset}
            onClick={() => navigate(Math.max(0, offset - page.limit))}
          >
            Previous invitations
          </button>
          <span>Page {Math.floor(offset / page.limit) + 1}</span>
          <button
            type="button"
            className="btn secondary"
            disabled={offset + page.limit >= page.total}
            onClick={() => navigate(offset + page.limit)}
          >
            Next invitations
          </button>
        </nav>
      )}
      {page.pilot && (
        <TeamInvite api={api} pilot={page.pilot} available={page.available} onRefresh={refresh} />
      )}
    </>
  );
}
