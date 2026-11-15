import { useRef, useState } from 'react';

/** Visible account action; the hosted shell supplies Clerk's session revocation. */
export function LogoutButton({ signOut }: { signOut: () => Promise<unknown> }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function logout() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await signOut();
      // Stay disabled until Clerk removes the session and navigates away.
    } catch {
      pending.current = false;
      setBusy(false);
      setError('We could not log you out. Check your connection and try again.');
    }
  }

  return <div className="logout-control">
    <button className="btn secondary" type="button" disabled={busy} aria-busy={busy} onClick={() => void logout()}>{busy ? 'Logging out…' : 'Log out'}</button>
    {error && <p className="logout-error" role="alert">{error}</p>}
  </div>;
}
