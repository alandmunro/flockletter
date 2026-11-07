import { useCallback } from 'react';
import { ClerkProvider, SignIn, SignUp, UserButton, OrganizationSwitcher, CreateOrganization, useAuth, useClerk } from '@clerk/react';
import { Portal, Header } from './App.js';

function Hosted({ workspaceConfigured }: { workspaceConfigured: boolean }) {
  const { isLoaded, isSignedIn, orgId, sessionId } = useAuth();
  const clerk = useClerk();
  const token = useCallback(async (refresh = false) => {
    const session = clerk.session;
    const stillSelected = () => clerk.session?.id === sessionId && clerk.organization?.id === orgId;
    if (!session || !orgId || !stillSelected()) return null;
    const value = await session.getToken({ organizationId: orgId, skipCache: refresh });
    return stillSelected() ? value : null;
  }, [clerk, orgId, sessionId]);
  const account = <><OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/" /><UserButton /></>;
  if (!isLoaded) return <><Header /><main className="main">Loading sign-in…</main></>;
  if (!isSignedIn) return <><Header /><main className="main"><section className="auth-card"><h1 className="page-heading">A thoughtful hello.</h1><p>Sign in to prepare your next newsletter.</p><a href="/pricing">See plans and limits</a>{window.location.pathname === '/sign-up' ? <SignUp routing="hash" signInUrl="/" forceRedirectUrl="/" /> : <SignIn routing="hash" signUpUrl="/sign-up" forceRedirectUrl="/" />}</section></main></>;
  if (!workspaceConfigured) {
    return <><Header account={<UserButton />} /><main className="main"><section className="card auth-card">
      <h1 className="page-heading">You’re signed in.</h1>
      <p>Your Flockletter workspace will open when the staging database and backend connection are ready.</p>
    </section></main></>;
  }
  if (!orgId) return <><Header account={account} /><main className="main"><h1 className="page-heading">Choose your workspace.</h1><p>Select an existing workspace above or create one to begin.</p><CreateOrganization routing="hash" afterCreateOrganizationUrl="/" /></main></>;
  return <Portal key={sessionId + ':' + orgId} getToken={token} account={account} local={false} />;
}

export default function HostedPortal({publishableKey,workspaceConfigured}:{publishableKey:string;workspaceConfigured:boolean}) {
  return <ClerkProvider publishableKey={publishableKey}><Hosted workspaceConfigured={workspaceConfigured}/></ClerkProvider>;
}
