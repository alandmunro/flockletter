import { useEffect, useRef, useState, type FormEvent } from 'react';
import { operationKey, type Api } from './api.js';
import type { TeamLifecycleView } from '../shared/customer-team.js';

type Action =
  | 'teamLifecycle.invite'
  | 'teamLifecycle.remove'
  | 'teamLifecycle.transfer'
  | 'teamLifecycle.revokeInvite'
  | 'teamLifecycle.exerciseAccept'
  | 'teamLifecycle.reconcile'
  | 'teamLifecycle.initializeExercise';
type Review = { command: Action; input: Record<string, string>; message: string; label: string };
const explain = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'The team request could not be completed.';
export function TeamLifecycle({ api }: { api: Api }) {
  const [view, setView] = useState<TeamLifecycleView>(),
    [revision, setRevision] = useState(0);
  const [email, setEmail] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review>();
  const pending = useRef(new Map<string, { signature: string; key: string }>()),
    inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    api
      .call<TeamLifecycleView>('teamLifecycle.status', {})
      .then((next) => {
        if (active) setView(next);
      })
      .catch((cause) => {
        if (active) setError(explain(cause));
      });
    return () => {
      active = false;
    };
  }, [api, revision]);
  async function change(command: Action, input: Record<string, string>, message: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const signature = JSON.stringify(input),
      slot = command + ':' + String(input.id ?? input.userId ?? input.email ?? 'setup');
    const previous = pending.current.get(slot),
      key = previous?.signature === signature ? previous.key : operationKey();
    pending.current.set(slot, { signature, key });
    try {
      const result = await api.call<{ state?: string }>(command, { ...input, operationKey: key });
      if (result.state !== 'uncertain') pending.current.delete(slot);
      setNotice(
        result.state === 'uncertain'
          ? 'The provider result is not yet known. Use “Check outcome”; do not send another invitation.'
          : message,
      );
      setReview(undefined);
      setRevision((n) => n + 1);
      if (command === 'teamLifecycle.invite' && result.state !== 'uncertain') setEmail('');
    } catch (cause) {
      setError(explain(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function invite(event: FormEvent) {
    event.preventDefault();
    void change('teamLifecycle.invite', { email }, 'Invitation prepared.');
  }
  function inspect(command: Action, input: Record<string, string>, label: string, message: string) {
    setError('');
    setReview({ command, input, label, message });
  }
  if (!view)
    return (
      <section className="card">
        <h2>Team membership</h2>
        {error ? (
          <p role="alert">
            {error}{' '}
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setError('');
                setRevision((n) => n + 1);
              }}
            >
              Retry team membership
            </button>
          </p>
        ) : (
          <p role="status">Loading team membership…</p>
        )}
      </section>
    );
  const exercise = view.mode === 'exercise';
  const used = view.members.length + view.invitations.filter((item) => item.state === 'pending').length;
  const full = view.seatLimit !== null && used >= view.seatLimit;
  return (
    <section className="card" aria-labelledby="team-lifecycle-heading">
      <h2 id="team-lifecycle-heading">Team membership</h2>
      <p>
        Invite teammates, remove membership, and transfer ownership. Brand permissions are managed separately
        below.
      </p>
      {exercise && (
        <p className="notice" role="status">
          Staging exercise: this team scenario does not change Clerk account access. Real sign-in and
          workspace permissions still come only from Clerk.
        </p>
      )}
      {view.mode === 'off' && <p className="notice">Team lifecycle operations are disabled.</p>}
      {error && (
        <p role="alert" className="notice error">
          {error} Retry the same request to check its original outcome.
        </p>
      )}
      {notice && (
        <p role="status" className="notice success">
          {notice}
        </p>
      )}
      {exercise && !view.initialized ? (
        <button
          className="btn"
          disabled={busy}
          type="button"
          onClick={() =>
            void change('teamLifecycle.initializeExercise', {}, 'Separate team exercise initialized.')
          }
        >
          Start team exercise
        </button>
      ) : (
        <>
          <p>
            {used} seats used or invited ·{' '}
            {view.seatLimit === null ? 'Unlimited plan seats' : view.seatLimit + ' plan seats'}
          </p>
          {full && (
            <p className="notice">
              Members and pending invitations fill the seat allowance. Revoke a pending invitation or remove a
              member before inviting someone else.
            </p>
          )}
          <form onSubmit={invite}>
            <fieldset disabled={busy || full || view.mode === 'off' || Boolean(review)}>
              <label>
                Teammate email
                <input
                  type="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <p className="help">
                New teammates join as members. An invitation reserves a seat until accepted or revoked.
              </p>
              <button className="btn" type="submit">
                {exercise ? 'Create exercise invitation' : 'Invite teammate'}
              </button>
            </fieldset>
          </form>
          {review && (
            <div className="notice" role="region" aria-label="Review team change">
              <h3>Review change</h3>
              <p>{review.label}</p>
              <div className="actions">
                <button
                  className="btn danger"
                  disabled={busy}
                  type="button"
                  onClick={() => void change(review.command, review.input, review.message)}
                >
                  Confirm change
                </button>
                <button
                  className="btn secondary"
                  disabled={busy}
                  type="button"
                  onClick={() => setReview(undefined)}
                >
                  Cancel change
                </button>
              </div>
            </div>
          )}
          <h3>{exercise ? 'Scenario members' : 'Workspace members'}</h3>
          <ul>
            {view.members.map((member) => (
              <li key={member.userId}>
                <strong>{member.email}</strong> · {member.role}
                <div className="actions">
                  {member.role === 'member' && (
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy || Boolean(review) || view.mode === 'off'}
                      onClick={() =>
                        inspect(
                          'teamLifecycle.transfer',
                          { userId: member.userId },
                          exercise
                            ? 'Make ' +
                                member.email +
                                ' the scenario owner? This does not grant any real access.'
                            : 'Transfer ownership to ' +
                                member.email +
                                '? Your owner membership will become a member only after their new ownership is verified.',
                          'Ownership transfer recorded.',
                        )
                      }
                    >
                      Transfer ownership
                    </button>
                  )}
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy || Boolean(review) || view.mode === 'off'}
                    onClick={() =>
                      inspect(
                        'teamLifecycle.remove',
                        { userId: member.userId },
                        exercise
                          ? 'Remove ' + member.email + ' from this scenario?'
                          : 'Remove ' +
                              member.email +
                              ' from the Clerk workspace and their Flockletter brand access?',
                        'Membership removal recorded.',
                      )
                    }
                  >
                    Remove member
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <h3>Invitations</h3>
          {!view.invitations.length && <p>No invitations yet.</p>}
          <ul>
            {view.invitations.map((invitation) => (
              <li key={invitation.id}>
                {invitation.email} · {invitation.state}
                {invitation.state === 'pending' && (
                  <div className="actions">
                    {exercise && (
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={busy || Boolean(review)}
                        onClick={() =>
                          void change(
                            'teamLifecycle.exerciseAccept',
                            { id: invitation.id },
                            'Invitation accepted in the separate scenario.',
                          )
                        }
                      >
                        Exercise acceptance
                      </button>
                    )}
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy || Boolean(review) || view.mode === 'off'}
                      onClick={() =>
                        inspect(
                          'teamLifecycle.revokeInvite',
                          { id: invitation.id },
                          'Revoke the pending invitation for ' + invitation.email + '?',
                          'Invitation revoked.',
                        )
                      }
                    >
                      Revoke invitation
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Recent changes</h3>
      {!view.operations.length && <p>No membership changes yet.</p>}
      <ul>
        {view.operations.map((item) => (
          <li key={item.id}>
            {item.action === 'revokeInvite' ? 'Revoke invitation' : item.action} · {item.state}
            {['prepared', 'submitting', 'uncertain'].includes(item.state) && (
              <button
                className="btn secondary"
                type="button"
                disabled={busy || Boolean(review)}
                onClick={() =>
                  void change('teamLifecycle.reconcile', { id: item.id }, 'Provider outcome checked.')
                }
              >
                Check outcome
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
