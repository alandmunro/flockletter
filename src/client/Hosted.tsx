import { useCallback } from 'react';
import { ClerkProvider, SignIn, SignUp, UserButton, OrganizationSwitcher, CreateOrganization, useAuth, useClerk, useReverification } from '@clerk/react';
import { Portal, Header } from './App.js';
import { OperatorPortal } from './OperatorPortal.js';
import { SetupStatus } from './SetupStatus.js';
import {authenticationReturnUrl,browserSubscriptionEntry,subscriptionSignupUrl} from './subscription-navigation.js';
import { LogoutButton } from './LogoutButton.js';

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
  const reverify=useReverification((action:()=>Promise<unknown>)=>action());
  const verify=useCallback((action:()=>Promise<unknown>)=>reverify(action),[reverify]);
  const returnUrl = authenticationReturnUrl(window.location);
  const signupUrl = subscriptionSignupUrl(browserSubscriptionEntry().plan);
  const logout = <LogoutButton signOut={() => clerk.signOut({ redirectUrl: '/' })} />;
  const account = <><OrganizationSwitcher hidePersonal afterSelectOrganizationUrl={returnUrl} afterCreateOrganizationUrl={returnUrl} /><UserButton />{logout}</>;
  if (!isLoaded) return <><Header /><main className="main">Loading sign-in…</main></>;
  if (!isSignedIn) return <><Header /><main className="main"><section className="auth-card"><h1 className="page-heading">A thoughtful hello.</h1><p>Sign in to prepare your next newsletter.</p><a href="/pricing">See plans and limits</a> · <a href="/help">Email support</a>{window.location.pathname === '/sign-up' ? <SignUp routing="hash" signInUrl={returnUrl} forceRedirectUrl={returnUrl} /> : <SignIn routing="hash" signUpUrl={signupUrl} forceRedirectUrl={returnUrl} />}</section></main></>;
  if (setupGaps.length) {
    return <><Header account={<><UserButton />{logout}</>} /><main className="main"><SetupStatus environment={environment} gaps={setupGaps} signedIn /></main></>;
  }
  if (!orgId) return <><Header account={account} /><main className="main"><h1 className="page-heading">Choose your workspace.</h1><p>Select an existing workspace above or create one to begin.</p><CreateOrganization routing="hash" afterCreateOrganizationUrl={returnUrl} /></main></>;
  if(window.location.pathname==='/operator')return <OperatorPortal key={sessionId+':'+orgId} getToken={token} account={account} verify={verify}/>;
  return <Portal key={sessionId + ':' + orgId} getToken={token} account={account} local={false} environment={environment} />;
}

export default function HostedPortal({publishableKey,...setup}:{publishableKey:string}&SetupProps) {
  return <ClerkProvider publishableKey={publishableKey} telemetry={false} afterSignOutUrl="/"><Hosted {...setup}/></ClerkProvider>;
}
