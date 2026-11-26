import {HostedPolicies} from './HostedPolicies.js';
import { StrictMode, lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Portal, Header } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { OperatorPortal } from './OperatorPortal.js';
import { SetupStatus } from './SetupStatus.js';
import { PublicPricingPage } from './PublicPlans.js';
import {Help} from './Help.js';
import {CookieControls} from './CookieControls.js';
import {Privacy} from './Privacy.js';
import './app.css';

type PublicConfig = { environment: string; localIdentity: boolean; clerkPublishableKey: string | null; setupGaps: string[]; sendingEnabled: boolean;workspaceGifts?:boolean;testSendingEnabled?:boolean };
const HostedPortal=lazy(()=>import('./Hosted.js'));
const localToken = async () => 'local-development-only';
function Root() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    void fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
      .then(async response => {
        if (!response.ok) throw new Error('Service configuration is unavailable.');
        const data = await response.json().catch(() => null) as PublicConfig | null;
        if (!data || typeof data !== 'object') throw new Error('Service configuration is unavailable.');
        setConfig(data);
      })
      .catch(() => setError('We could not reach Flockletter. Retry or refresh the page.'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!config) return (
    <>
      <Header />
      <main className="main">
        <p role="status">{error || 'Opening Flockletter…'}</p>
        {error && <p><button type="button" onClick={load}>Retry</button></p>}
      </main>
    </>
  );
  const workspaceConfigured = config.setupGaps.length === 0;
  if (config.localIdentity && workspaceConfigured) return window.location.pathname==='/operator'?<OperatorPortal getToken={localToken}/>:<Portal getToken={localToken} local environment={config.environment} workspaceGifts={config.workspaceGifts === true} />;
  if (!config.localIdentity && config.clerkPublishableKey) {
    return <Suspense fallback={<><Header/><main className="main"><p role="status">Loading sign-in…</p></main></>}><HostedPortal workspaceGifts={config.workspaceGifts === true} publishableKey={config.clerkPublishableKey} environment={config.environment} setupGaps={config.setupGaps}/></Suspense>;
  }
  return <><Header /><main className="main"><SetupStatus environment={config.environment} gaps={config.setupGaps}/></main></>;
}
const legalPage=window.location.pathname==='/terms'?'terms':window.location.pathname==='/acceptable-use'?'acceptable-use':window.location.pathname==='/refunds'?'refunds':null;
const publicPage=legalPage?<HostedPolicies page={legalPage}/>:window.location.pathname==='/pricing'?<PublicPricingPage/>:window.location.pathname==='/help'?<Help/>:['/privacy','/policies/privacy','/cookies'].includes(window.location.pathname)?<Privacy/>:null;
createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary>{publicPage?<><Header/>{publicPage}</>:<Root/>}<CookieControls/></ErrorBoundary></StrictMode>);
