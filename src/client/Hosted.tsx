import { useCallback } from 'react';
import { ClerkProvider, SignIn, SignUp, UserButton, OrganizationSwitcher, CreateOrganization, useAuth, useClerk } from '@clerk/react';
import { Portal, Header } from './App.js';
import { SetupStatus } from './SetupStatus.js';

type SetupProps = {environment:string; setupGaps:string[]};
function Hosted({ environment,setupGaps }: SetupProps) {
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
  if (!isSignedIn) return <><Header /><main className="main"><section className="auth-card"><h1 className="page-heading">A thoughtful hello.</h1><p>Sign in to prepare your next newsletter.</p><a href="/pricing">See plans and limits</a> · <a href="/help">Email support</a>{window.location.pathname === '/sign-up' ? <SignUp routing="hash" signInUrl="/" forceRedirectUrl="/" /> : <SignIn routing="hash" signUpUrl="/sign-up" forceRedirectUrl="/" />}</section></main></>;
  if (setupGaps.length) {
    return <><Header account={<UserButton />} /><main className="main"><SetupStatus environment={environment} gaps={setupGaps} signedIn /></main></>;
  }
  if (!orgId) return <><Header account={account} /><main className="main"><h1 className="page-heading">Choose your workspace.</h1><p>Select an existing workspace above or create one to begin.</p><CreateOrganization routing="hash" afterCreateOrganizationUrl="/" /></main></>;
  return <Portal key={sessionId + ':' + orgId} getToken={token} account={account} local={false} />;
}

export default function HostedPortal({publishableKey,...setup}:{publishableKey:string}&SetupProps) {
  return <ClerkProvider publishableKey={publishableKey}><Hosted {...setup}/></ClerkProvider>;
}
