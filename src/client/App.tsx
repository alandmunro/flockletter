import {browserSubscriptionEntry,subscriptionUrl} from './subscription-navigation.js';
import {hostedTrial} from '../shared/trial.js';
import {sitePresentation} from '../shared/site-presentation.js';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { emptyContent, type AssetSummary, type Brand, type Campaign, type Capability, type Connection, type Workspace } from '../shared/contracts.js';
import { client, operationKey, type Api, type TokenGetter } from './api.js';
import {useBrandImages} from './useBrandImages.js';
import { BrandImageUpload } from './BrandImageUpload.js';
import { NewsletterEditor as Editor } from './NewsletterEditor.js';
import { emptyStudio } from '../shared/studio.js';
import { IntakePanel } from './IntakePanel.js';
import { Audience } from './Audience.js';
import { Authoring } from './Authoring.js';
import { WorkspaceAccessPanel } from './Rehearsals.js';
import { SenderDomain } from './SenderDomain.js';
import { BillingPanel } from './BillingPanel.js';
import { PlanCards } from './PublicPlans.js';
import {WorkspaceSetupProgress} from './WorkspaceSetupProgress.js';
import { Companies } from './Companies.js';
import { Operations } from './Operations.js';
import { DraftReader } from './DraftReader.js';
import { Team } from './Team.js';
import { Retention } from './Retention.js';
import { SubscriptionLifecycle } from './SubscriptionLifecycle.js';
import { CustomerDeliveryPanel } from './CustomerDeliveryPanel.js';
import { TeamLifecycle } from './TeamLifecycle.js';
import { SupportPortal } from './SupportPortal.js';
import { DataRetention } from './DataRetention.js';
import { CustomerOperations } from './CustomerOperations.js';
import {Gifting} from './Gifting.js';
import { WorkspaceGifts, workspaceGiftReturnUrl } from './WorkspaceGifts.js';
import {giftPracticeEnabled} from '../shared/gifting.js';
import { Texting } from './Texting.js';
import { InfrastructureSetup } from './InfrastructureSetup.js';

const NewsletterImport = lazy(async () => ({default:(await import('./NewsletterImport.js')).NewsletterImport}));

export function Header({ account, workspaceName }: { account?: ReactNode; workspaceName?: string }) {
  return <header className="app-header">
    <a className="wordmark" href="/" aria-label="Flockletter home"><i aria-hidden="true">f</i>flockletter</a>
    <div className="header-account">{workspaceName && <strong className="workspace-name">{workspaceName}</strong>}{account}</div>
    <img className="software-logo" src="/brand/frosty-flamingo-software.png" alt="Frosty Flamingo Software" width="88" height="64" />
  </header>;
}

const workspacePages = [
  ['overview', 'Overview'], ['campaigns', 'Campaigns'], ['audience', 'Audience'],
  ['delivery', 'Delivery'], ['texting', 'Texting'], ['gifts','Gifts'], ['gifting','Gift lab'], ['media', 'Image library'], ['subscription', 'Subscription'],
  ['team', 'Team'], ['settings', 'Workspace'], ['connections', 'API & MCP'],
  ['operations', 'Operations'], ['privacy', 'Data & privacy'], ['support', 'Support'],
] as const;

function WorkspaceNav({page, disabled, navigate, member = false, canSendTexts = false, gifts = false, workspaceGifts = false}: {
  page: string; disabled: boolean; navigate: (page: string) => void; member?: boolean; canSendTexts?: boolean; gifts?:boolean; workspaceGifts?:boolean;
}) {
  const pages = member ? workspacePages.filter(([id]) => id === 'campaigns' || id === 'media' || (id === 'gifts' && workspaceGifts) || (id === 'texting' && canSendTexts)) : workspacePages.filter(([id])=>(id!=='gifting'||gifts) && (id!=='gifts'||workspaceGifts));
  return <nav className="workspace-nav" aria-label="Main navigation">
    {pages.map(([id, title]) => <button key={id} type="button" disabled={disabled}
      aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>{title}</button>)}
  </nav>;
}

function Alert({ error }: { error: string }) { return error ? <div role="alert" className="notice error">{error}</div> : null; }
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please retry.';
export function Portal({ getToken, account, local, environment, workspaceGifts = false }: { getToken: TokenGetter; account?: ReactNode; local: boolean; environment?:string; workspaceGifts?:boolean }) {
  const presentation=sitePresentation(environment??(local?'local':undefined));
  const api = useMemo(() => client(getToken), [getToken]);
  const [workspace, setWorkspace] = useState<Workspace | null>();
  const [error, setError] = useState('');
  const [page, setPage] = useState(() => workspaceGifts && workspaceGiftReturnUrl(window.location) ? 'gifts' : browserSubscriptionEntry().subscription ? 'subscription' : 'overview');
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [signupBrand, setSignupBrand] = useState<string>();
  const [editorDirty, setEditorDirty] = useState(false);
  const load = useCallback(async () => { setError(''); try { setWorkspace(await api.call<Workspace | null>('workspace.get', {})); } catch (e) { setWorkspace(undefined); setError(message(e)); } }, [api]);
  useEffect(() => { void load(); }, [load]);
  const navigate = (next: string) => {
    const entry=browserSubscriptionEntry();
    if(next==='subscription')window.history.replaceState(null,'',subscriptionUrl(entry.plan));
    else if(next==='gifts' && workspaceGifts && !workspaceGiftReturnUrl(window.location))window.history.replaceState(null,'','/?gifts=1');
    else if(next!=='gifts' && (entry.subscription || workspaceGiftReturnUrl(window.location)))window.history.replaceState(null,'','/');
    setSignupBrand(undefined); setSelected(null); setPage(next);
  };
  if(workspace===undefined) return <><Header account={account}/><main id="main" className="main"><section className="card" aria-label="Workspace access"><p>{error ? 'Your workspace could not load.' : 'Loading your workspace…'}</p><Alert error={error}/>{error && <button className="btn" onClick={()=>void load()}>Retry</button>}</section></main></>;
  if(workspace && !workspace.canManageConnections) return <MemberPortal api={api} workspace={workspace} account={account} workspaceGifts={workspaceGifts && workspace.brands.length > 0} />;
return <><a href="#main" className="skip-link">Skip to content</a><Header workspaceName={workspace?.name} account={account ?? <span className="badge">Local test workspace</span>} /><WorkspaceNav page={page} disabled={editorDirty} navigate={navigate} workspaceGifts={workspaceGifts && Boolean(workspace)} gifts={giftPracticeEnabled(environment??(local?'local':undefined))}/><div className="workspace-shell"><main id="main" className="main"><div className="environment-note">{presentation.workspaceNotice}</div><Alert error={error} />{workspace === null ? <Onboarding api={api} done={async()=>{await load();navigate('subscription');}} /> : <>{page === 'overview' && <><Overview workspace={workspace} navigate={navigate} /><WorkspaceSetupProgress api={api} workspace={workspace} onNavigate={navigate}/></>}{page === 'campaigns' && (selected ? <Editor key={selected.id} api={api} initial={selected} onDirty={setEditorDirty} back={() => setSelected(null)} /> : <Campaigns api={api} brands={workspace.brands} open={setSelected} />)}{page === 'audience' && <Audience initialBrand={signupBrand} api={api} brands={workspace.brands} canManageAutomations={workspace.canManageConnections} onSetup={() => navigate('connections')} />}{page === 'media' && <WorkspaceMedia api={api} brands={workspace.brands} />}{page === 'connections' && <Connections api={api} workspace={workspace} workspaceGifts={workspaceGifts} />}{page === 'team' && <><TeamLifecycle api={api}/><Team api={api} brands={workspace.brands} textingEnabled={workspace.canSendTexts}/></>}{page==='gifts' && workspaceGifts && <GiftBrandPage api={api} brands={workspace.brands}/>}{page==='gifting'&&giftPracticeEnabled(environment??(local?'local':undefined))&&<Gifting api={api}/>}{page==='texting'&&<Texting api={api} onOpenAudience={brand => { navigate('audience'); setSignupBrand(brand); }}/>}{page==='delivery'&&<CustomerDeliveryPanel api={api} brands={workspace.brands} canChooseProvider={workspace.canManageConnections}/>} {page==='subscription'&&<SubscriptionLifecycle api={api} onContinueSetup={()=>navigate('delivery')} initialPlan={browserSubscriptionEntry().plan} returnedFromStripe={Boolean(browserSubscriptionEntry().billingReturn)} onPlanChange={plan=>window.history.replaceState(null,'',subscriptionUrl(plan))}/>} {page==='support'&&<SupportPortal api={api}/>} {page==='privacy'&&<DataRetention api={api}/>} {page==='operations'&&<><CustomerOperations api={api}/><InfrastructureSetup api={api} brands={workspace.brands}/></>} {page === 'settings' && <><Settings workspace={workspace} environment={presentation.environment} /><WorkspaceAccessPanel api={api}/><Companies api={api} onChanged={load}/><BillingPanel api={api}/><Retention api={api}/><Operations api={api} openCampaign={campaign=>{setSelected(campaign);setPage('campaigns');}}/>{workspace.brands.map(brand=><SenderDomain key={brand.id} api={api} brand={brand}/>)}</>}</>}<footer className="footer">Flockletter · Frosty Flamingo Software · <a href="/help">Email support</a> · <a href="https://github.com/alandmunro/flockletter" target="_blank" rel="noreferrer">Open source, AGPLv3</a></footer></main></div></>;
}
function GiftBrandPage({ api, brands }: {api: Api; brands: Brand[]}) {
  const [selected, setSelected] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return query.get('brand') ?? (query.has('purchase') && brands.length > 1 ? '' : brands[0]?.id ?? '');
  });
  const chosen = brands.find(brand => brand.id === selected);
  const choose = (id: string) => {
    const query = new URLSearchParams({gifts: '1', brand: id});
    // An unbranded return may need the owner to choose the purchase's brand.
    const prior = new URLSearchParams(window.location.search);
    const purchase = prior.get('purchase');
    if (purchase && (!prior.has('brand') || prior.get('brand') === id)) query.set('purchase', purchase);
    window.history.replaceState(null, '', '/?' + query);
    setSelected(id);
  };
  if (!brands.length) return <p>No brands are available for gifting.</p>;
  return <>
    <div className="field">
      <label htmlFor="workspace-gift-brand">Gift brand</label>
      <select id="workspace-gift-brand" value={chosen?.id ?? ''} onChange={e=>choose(e.target.value)}>
        {!chosen && <option value="">Choose a workspace brand</option>}
        {brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
      </select>
    </div>
    {chosen ? <WorkspaceGifts api={api} brandId={chosen.id}/> : <p>Choose a brand to view its gift activity.</p>}
  </>;
}
function Onboarding({ api, done }: { api: Api; done: () => Promise<void> }) {
  const [name, setName] = useState(''); const [brand, setBrand] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const key = useRef(operationKey());
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.call('workspace.initialize', { operationKey: key.current, name, brandName: brand }); await done(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="card auth-card"><h1 className="page-heading">Create your workspace</h1><p>Give your workspace and first brand a name. You can prepare your first newsletter before setting up delivery.</p><Alert error={error} /><form onSubmit={submit}><fieldset disabled={busy}><div className="field"><label htmlFor="workspace-name">Workspace name</label><input id="workspace-name" value={name} maxLength={100} required onChange={e => { setName(e.target.value); key.current = operationKey(); }} placeholder="Your business" /></div><div className="field"><label htmlFor="brand-name">Sending brand</label><input id="brand-name" value={brand} maxLength={100} required onChange={e => { setBrand(e.target.value); key.current = operationKey(); }} placeholder="The name readers recognize" /></div><button className="btn" type="submit">{busy ? 'Creating workspace…' : 'Create workspace'}</button></fieldset></form><p className="help">This creates your preparation workspace. It does not start a paid plan or a trial.</p></section>;
}
function Overview({ workspace, navigate }: { workspace: Workspace; navigate: (page: string) => void }) {
  return <>
    <header className="overview-heading">
      <div><span className="eyebrow">Workspace overview</span><h1 className="page-heading">{workspace.name}</h1></div>
      <button className="btn" onClick={()=>navigate('campaigns')}>Open campaigns <span aria-hidden="true">→</span></button>
    </header>
  </>;
}
function Campaigns({ api, brands, open,canWrite=true }: { api: Api; brands: Brand[]; open: (campaign: Campaign) => void;canWrite?:boolean }) {
  const [items, setItems] = useState<Campaign[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [loaded, setLoaded] = useState(false);
  const [importing,setImporting]=useState(false);
  const createKey = useRef(operationKey());
  const [brandId,setBrandId]=useState(brands[0]?.id??'');
  const chosen=brands.find(b=>b.id===brandId)??brands[0];
  const load = useCallback(() => api.call<Campaign[]>('campaign.list', {}).then(setItems).catch(e => setError(message(e))).finally(() => setLoaded(true)), [api]);
  useEffect(() => { void load(); }, [load]);
  async function create() { setBusy(true); setError(''); try { const draft = await api.call<Campaign>('campaign.create', { operationKey: createKey.current, brandId: chosen!.id, content: { ...emptyContent(), title: 'Untitled campaign', fromName: chosen!.name, studio: emptyStudio() } }); createKey.current = operationKey(); open(draft); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  return <><div className="actions"><div><h1 className="page-heading">Campaigns</h1></div>{canWrite && brands.length>1 && <div className="editor-brand-select"><label htmlFor="new-campaign-brand">Brand for new campaign</label><select id="new-campaign-brand" value={chosen?.id??''} disabled={busy || importing} onChange={e=>{setBrandId(e.target.value);createKey.current=operationKey();}}>{brands.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></div>}{canWrite && !importing && <button className="btn secondary" disabled={busy || !chosen} onClick={()=>setImporting(true)}>Import newsletter</button>}{canWrite && !importing && <button className="btn" disabled={busy || !chosen} onClick={() => void create()}>{busy ? 'Creating…' : '+ New campaign'}</button>}</div><Alert error={error} />{importing&&chosen&&<Suspense fallback={<p role="status">Loading newsletter import…</p>}><NewsletterImport key={chosen.id} api={api} brand={chosen} drafts={items} open={open} cancel={()=>setImporting(false)}/></Suspense>} {!importing && canWrite && <Authoring api={api} brands={brands} open={open} />}<section className="card">{!loaded ? <p>Loading campaigns…</p> : items.length === 0 ? <div className="empty"><div className="letter-art" aria-hidden="true"/><h2>No campaigns yet</h2><p>{canWrite?'Create a draft and add your images. Drafts never use a campaign allowance.':'No drafts are available for your brands.'}</p></div> : items.map(c => <article className="campaign-row" key={c.id}><div><h2>{c.content.title || 'Untitled campaign'}</h2><p className="muted">{c.content.subject || 'Add a subject'} · Saved {new Date(c.updatedAt).toLocaleDateString()}</p></div><span className="badge">Draft · v{c.version}</span><button className="btn secondary" onClick={() => open(c)} aria-label={`${canWrite?'Edit':'View'} ${c.content.title || 'untitled campaign'}`}>Open draft</button></article>)}</section></>;
}
function ImageTile({ asset, api }: { asset: AssetSummary; api: Api }) {
  const [url, setUrl] = useState('');
  useEffect(() => { let alive = true; let blob = ''; void api.asset(asset.id).then(value => { blob = value; if (alive) setUrl(value); else URL.revokeObjectURL(value); }).catch(() => {}); return () => { alive = false; if (blob) URL.revokeObjectURL(blob); }; }, [asset.id, api]);
  return <figure>{url ? <img src={url} alt={asset.name} /> : <div className="empty">Image unavailable</div>}<figcaption><strong>{asset.name}</strong><p className="help">{asset.width} × {asset.height} · {(asset.size / 1024).toFixed(0)} KB</p></figcaption></figure>;
}
function WorkspaceMedia({api,brands,canWrite=true}:{api:Api;brands:Brand[];canWrite?:boolean}){
  const [selected,setSelected]=useState(brands[0]?.id);
  const brand=brands.find(item=>item.id===selected)??brands[0];
  if(!brand)return <p>No image libraries are available.</p>;
  return <>{brands.length>1&&<><label htmlFor="library-brand">Image library brand</label><select id="library-brand" value={brand.id} onChange={e=>setSelected(e.target.value)}>
    {brands.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></>}
    <Media key={brand.id} api={api} brand={brand} canWrite={canWrite}/></>;
}
function Media({api,brand,canWrite}:{api:Api;brand:Brand;canWrite:boolean}){
  const {assets:items,error,accept,retry,ready}=useBrandImages(api,brand.id);
  return <><h1 className="page-heading">Image library</h1><p className="page-intro">Original photos for {brand.name}. {canWrite?'Upload originals for your drafts.':'Read-only image library.'}</p>
    <Alert error={error}/>{error&&<button className="btn secondary" onClick={retry}>Retry image library</button>}
    {canWrite&&<section className="card"><BrandImageUpload api={api} brandId={brand.id} onUploaded={accept}/></section>}
    <div className="media-grid">{items.map(asset=><ImageTile key={asset.id} asset={asset} api={api}/>)}</div>
    {ready&&!items.length&&<section className="card empty"><h2>No images in this brand yet.</h2></section>}</>;
}
function Connections({ api, workspace, workspaceGifts }: { api: Api; workspace: Workspace; workspaceGifts: boolean }) {
  const [items, setItems] = useState<Connection[]>([]); const [name, setName] = useState(''); const [scopes, setScopes] = useState<Capability[]>(['read']); const [token, setToken] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [brandIds,setBrandIds] = useState<string[]>(() => workspace.brands.slice(0,1).map(b => b.id));
  const key = useRef(operationKey());
  const load = useCallback(() => api.call<Connection[]>('connection.list', {}).then(setItems), [api]);
  useEffect(() => { if (workspace.canManageConnections) void load().catch(e => setError(message(e))); }, [load, workspace.canManageConnections]);
  function selectScope(scope: Capability, checked: boolean) {
    setScopes(current => checked ? [...current, scope] :
      current.filter(s => s !== scope && !(scope === 'read' && s === 'gifts:read')));
    key.current = operationKey();
  }
  async function create(e: FormEvent) { e.preventDefault(); setBusy(true); setTestResult(''); setError(''); setToken(''); try { const result = await api.call<{ token?: string }>('connection.create', { operationKey: key.current, name, scopes, brandIds, expiresInDays: 30 }); if (result.token) setToken(result.token); else setError('This token was already issued and cannot be recovered. Revoke that connection and create a new one.'); key.current = operationKey(); await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  const [testResult, setTestResult] = useState('');
  async function testConnection() {
    setBusy(true);
    setTestResult('');
    try {
      const { testHostedConnection } = await import('./test-hosted-connection.js');
      const count = await testHostedConnection(token);
      setTestResult(`Connected to Flockletter. ${count} tools available.`);
    } catch { setTestResult('Connection test failed. Check the connection and try again.'); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) { setBusy(true); setError(''); try { await api.call('connection.revoke', { operationKey: operationKey(), id }); setToken(''); await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  return <><h1 className="page-heading">API & MCP connections</h1><p className="page-intro">Let your tools prepare campaigns with only the access they need. Every tier includes API and MCP access.</p><Alert error={error} />{workspace.canManageConnections ? <section className="card"><h2>Create a connection</h2><form onSubmit={create}><fieldset disabled={busy}><div className="field"><label htmlFor="connection-name">Connection name</label><input id="connection-name" required maxLength={80} value={name} placeholder="My campaign assistant" onChange={e => { setName(e.target.value); key.current = operationKey(); }} /></div><legend className="help">Choose access. Expires in 30 days.</legend><fieldset><legend>Brands</legend>{workspace.brands.map(b => <label className="asset-option" key={b.id}><input type="checkbox" checked={brandIds.includes(b.id)} onChange={e => { setBrandIds(current => e.target.checked ? [...current,b.id] : current.filter(id => id !== b.id)); key.current=operationKey(); }} />{b.name}</label>)}</fieldset>{([['read', 'Read drafts, previews and images'], ['gifts:read', 'View gift credit and campaign reports for selected brands (read-only, requires read)'], ['audience:write','Import authorized contacts and queue confirmation (brand-scoped; no private confirmation tokens)'], ['audience:confirm','Subscribe selected contacts or imports without email verification, based on recorded permission (separate access)'], ['sender:configure','Provision this brand’s verified sending domain (also select draft read; no sending or paid plan changes)'], ['delivery:configure','Choose AWS SES or Resend for allowed brands (also select draft read; does not grant sending)'], ['automation:manage','Manage annual greetings for selected brands (also select read and the sending channels to activate)'], ['sms:send','Review and send marketing texts for the selected company brands'], ['campaign:send','Review, approve and schedule campaign delivery (also select draft read)'], ['draft:write', 'Create and edit drafts'], ['assets:write', 'Upload images'], ['audience:summary','Read audience totals by status'],['campaign:rehearse','Review and run local campaign rehearsals'],['campaign:simulate','Run feedback tests that can suppress test contacts, or use an operator-configured AWS simulator (also select draft read and rehearsals)']] as [Capability, string][]).filter(([scope]) => scope !== 'gifts:read' || workspaceGifts).map(([scope, label]) => <label className="asset-option" key={scope}><input type="checkbox" checked={scopes.includes(scope)} disabled={scope === 'gifts:read' && !scopes.includes('read')} onChange={e => selectScope(scope, e.target.checked)} />{label}</label>)}<button className="btn" disabled={scopes.length === 0 || brandIds.length === 0 || brandIds.length > 5} type="submit">Create connection</button></fieldset></form>{token && <div className="notice success" role="status"><strong>Copy this token now. It is shown only once.</strong><pre className="token-output">{token}</pre><button className="btn secondary" disabled={busy} onClick={() => void testConnection()}>Test MCP connection</button>{testResult && <p role="status">{testResult}</p>}<button className="btn secondary" onClick={() => setToken('')}>I have saved it securely</button></div>}</section> : <p>Workspace owners manage connections.</p>}{workspace.canManageConnections && workspace.brands.map(brand => <IntakePanel key={brand.id} api={api} brand={brand} onIssued={load} />)}<section className="card" id="workspace-connections"><h2>Your connections</h2>{items.length ? items.map(c => <article className="connection-row" key={c.id}><div><strong>{c.name}</strong><p className="help">{c.scopes.join(', ')} · {c.revokedAt ? 'Revoked' : `Expires ${new Date(c.expiresAt).toLocaleDateString()}`}</p></div>{!c.revokedAt && <button className="btn danger" disabled={busy} onClick={() => void revoke(c.id)}>Revoke</button>}</article>) : <p>No connections yet.</p>}<p className="help">Tokens cannot change members, billing or other connections. Removing an issuing owner also removes the connection’s authority.</p></section><section className="card"><h2>Connect your assistant</h2><p>Choose Streamable HTTP in your MCP client and enter <code>{window.location.origin}/api/v1/mcp</code>. Use your connection token as the bearer token.</p><a href="https://github.com/alandmunro/flockletter/blob/main/docs/implementation/API_MCP.md" target="_blank" rel="noreferrer">API & MCP setup guide →</a></section></>;
}
function Settings({ workspace,environment }: { workspace: Workspace;environment?:string }) {
  return <><h1 className="page-heading">Your workspace</h1><section className="card"><h2>{workspace.name}</h2><p>Brand: {workspace.brands.map(b => b.name).join(', ')}</p><p className="badge">{workspace.accessLabel??(workspace.entitlement==='complimentary'?'Complimentary access':'Preparation access')}</p><p>Clerk manages sign-in and workspace membership. Owners manage brand access in Team and review delivery and billing setup below.</p><p>Each brand sets its signup confirmation policy in Audience. Open and click tracking stay off.</p></section><p><a href="/operator">Open platform control room →</a></p><h2>Hosted plans and shared allowances</h2><p>Allowances are shared across every company and brand in a subscription. Subscription shows this workspace’s recorded service and trial state.</p><PlanCards catalog={workspace.plans} headingLevel={3}/><p className="help">The ordinary trial is 14 days, requires a card, and includes at most {hostedTrial.activeContacts.toLocaleString('en-US')} active contacts and {hostedTrial.totalEmails.toLocaleString('en-US')} total emails including tests. {sitePresentation(environment).trialNote}</p></>;
}

function MemberPortal({api,workspace,account,workspaceGifts}:{api:Api;workspace:Workspace;account?:ReactNode;workspaceGifts:boolean}){
  const [tab,setTab]=useState<'campaigns'|'media'|'texting'|'gifts'>(() => workspaceGifts && workspaceGiftReturnUrl(window.location) ? 'gifts' : 'campaigns'),[draft,setDraft]=useState<Campaign|null>(null),[dirty,setDirty]=useState(false);
  const writable=workspace.canEdit===true;
  const canSendTexts=workspace.canSendTexts===true;
  const page=(tab==='texting'&&!canSendTexts || tab==='gifts'&&!workspaceGifts)?'campaigns':tab;
  function navigate(next: string) {
    setDraft(null);
    if (next==='gifts' && workspaceGifts) {
      if (!workspaceGiftReturnUrl(window.location)) window.history.replaceState(null, '', '/?gifts=1');
      setTab('gifts');
    } else {
      if (workspaceGiftReturnUrl(window.location)) window.history.replaceState(null, '', '/');
      setTab(next==='texting' && canSendTexts ? 'texting' : next==='media' ? 'media' : 'campaigns');
    }
  }
  return <><a href="#main" className="skip-link">Skip to content</a><Header account={account} workspaceName={workspace.name}/><WorkspaceNav member canSendTexts={canSendTexts} workspaceGifts={workspaceGifts} page={page} disabled={dirty} navigate={navigate}/><div className="workspace-shell">
    <main id="main" className="main"><p className="notice">{writable?'Editor':'Viewer'} access · {workspace.brands.map(b=>b.name).join(', ')}</p>
    {page==='gifts'?<GiftBrandPage api={api} brands={workspace.brands}/>:page==='texting'?<Texting api={api} manage={false}/>:page==='campaigns'?(draft?(writable?<Editor api={api} initial={draft} onDirty={setDirty} rehearse={false} back={()=>setDraft(null)}/>:<DraftReader api={api} draft={draft} back={()=>setDraft(null)}/>):<Campaigns api={api} brands={workspace.brands} open={setDraft} canWrite={writable}/>):<WorkspaceMedia api={api} brands={workspace.brands} canWrite={writable}/>}</main></div></>;
}
