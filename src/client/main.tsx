import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider, SignIn, SignUp, UserButton, OrganizationSwitcher, CreateOrganization, useAuth } from '@clerk/react';
import { Portal, Header } from './App.js';
import './app.css';

type PublicConfig = { environment: string; localIdentity: boolean; clerkPublishableKey: string | null; setupGaps: string[]; sendingEnabled: false };
function Hosted({ workspaceConfigured }: { workspaceConfigured: boolean }) {
  const { isLoaded, isSignedIn, orgId, getToken } = useAuth();
  const token = useCallback(() => getToken(), [getToken]);
  const account = <><OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/" /><UserButton /></>;
  if (!isLoaded) return <><Header /><main className="main">Loading sign-in…</main></>;
  if (!isSignedIn) return <><Header /><main className="main"><section className="auth-card"><h1 className="page-heading">A thoughtful hello.</h1><p>Sign in to prepare your next newsletter.</p>{window.location.pathname === '/sign-up' ? <SignUp routing="hash" signInUrl="/" forceRedirectUrl="/" /> : <SignIn routing="hash" signUpUrl="/sign-up" forceRedirectUrl="/" />}</section></main></>;
  if (!workspaceConfigured) {
    return <><Header account={<UserButton />} /><main className="main"><section className="card auth-card">
      <h1 className="page-heading">You’re signed in.</h1>
      <p>Your Flockletter workspace will open when the staging database and backend connection are ready.</p>
    </section></main></>;
  }
  if (!orgId) return <><Header account={account} /><main className="main"><h1 className="page-heading">Choose your workspace.</h1><p>Select an existing workspace above or create one to begin.</p><CreateOrganization routing="hash" afterCreateOrganizationUrl="/" /></main></>;
  return <Portal key={orgId} getToken={token} account={account} local={false} />;
}
const localToken = async () => 'local-development-only';
function Root() {
  const [config, setConfig] = useState<PublicConfig | null>(null); const [error, setError] = useState('');
  useEffect(() => { void fetch('/api/config').then(async response => { if (!response.ok) throw new Error('Service configuration is unavailable.'); setConfig(await response.json() as PublicConfig); }).catch(() => setError('We could not reach Flockletter. Refresh to retry.')); }, []);
  if (!config) return <><Header /><main className="main"><p role="status">{error || 'Opening Flockletter…'}</p></main></>;
  const workspaceConfigured = config.setupGaps.length === 0;
  if (config.localIdentity && workspaceConfigured) return <Portal getToken={localToken} local />;
  if (!config.localIdentity && config.clerkPublishableKey) {
    return <ClerkProvider publishableKey={config.clerkPublishableKey}><Hosted workspaceConfigured={workspaceConfigured} /></ClerkProvider>;
  }
  return <><Header /><main className="main"><section className="auth-card card"><h1 className="page-heading">Staging setup</h1><p>Sign-in will be available once the staging account is connected.</p><a href="https://github.com/alandmunro/flockletter">View the open-source project</a></section></main></>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
