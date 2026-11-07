import { StrictMode, lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Portal, Header } from './App.js';
import { PublicPlans } from './PublicPlans.js';
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
    return <Suspense fallback={<><Header/><main className="main"><p role="status">Loading sign-in…</p></main></>}><HostedPortal publishableKey={config.clerkPublishableKey} workspaceConfigured={workspaceConfigured}/></Suspense>;
  }
  return <><Header /><main className="main"><section className="auth-card card"><h1 className="page-heading">Staging setup</h1><p>Sign-in will be available once the staging account is connected.</p><a href="https://github.com/alandmunro/flockletter">View the open-source project</a></section></main></>;
}
createRoot(document.getElementById('root')!).render(<StrictMode>{window.location.pathname==='/pricing'?<><Header/><PublicPlans/></>:<Root/>}</StrictMode>);
