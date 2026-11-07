import { StrictMode, lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Portal, Header } from './App.js';
import { SetupStatus } from './SetupStatus.js';
import { PublicPlans } from './PublicPlans.js';
import {Help} from './Help.js';
import './app.css';

type PublicConfig = { environment: string; localIdentity: boolean; clerkPublishableKey: string | null; setupGaps: string[]; sendingEnabled: false };
const HostedPortal=lazy(()=>import('./Hosted.js'));
const localToken = async () => 'local-development-only';
function Root() {
  const [config, setConfig] = useState<PublicConfig | null>(null); const [error, setError] = useState('');
  useEffect(() => { void fetch('/api/config').then(async response => { if (!response.ok) throw new Error('Service configuration is unavailable.'); setConfig(await response.json() as PublicConfig); }).catch(() => setError('We could not reach Flockletter. Refresh to retry.')); }, []);
  if (!config) return <><Header /><main className="main"><p role="status">{error || 'Opening Flockletter…'}</p></main></>;
  const workspaceConfigured = config.setupGaps.length === 0;
  if (config.localIdentity && workspaceConfigured) return <Portal getToken={localToken} local />;
  if (!config.localIdentity && config.clerkPublishableKey) {
    return <Suspense fallback={<><Header/><main className="main"><p role="status">Loading sign-in…</p></main></>}><HostedPortal publishableKey={config.clerkPublishableKey} environment={config.environment} setupGaps={config.setupGaps}/></Suspense>;
  }
  return <><Header /><main className="main"><SetupStatus environment={config.environment} gaps={config.setupGaps}/></main></>;
}
const publicPage=window.location.pathname==='/pricing'?<PublicPlans/>:window.location.pathname==='/help'?<Help/>:null;
createRoot(document.getElementById('root')!).render(<StrictMode>{publicPage?<><Header/>{publicPage}</>:<Root/>}</StrictMode>);
