import {browserSubscriptionEntry,subscriptionUrl} from './subscription-navigation.js';
import {sitePresentation} from '../shared/site-presentation.js';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type FormEvent } from 'react';
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
import { InfrastructureSetup } from './InfrastructureSetup.js';

export function Header({ account }: { account?: ReactNode }) {
  return <header className="app-header"><a className="wordmark" href="/">flockletter<span>Good things, delivered.</span></a><div className="header-account">{account}</div><img className="software-logo" src="/brand/frosty-flamingo-software.png" alt="Frosty Flamingo Software" width="88" height="64" /></header>;
}
function Alert({ error }: { error: string }) { return error ? <div role="alert" className="notice error">{error}</div> : null; }
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please retry.';
export function Portal({ getToken, account, local, environment }: { getToken: TokenGetter; account?: ReactNode; local: boolean; environment?:string }) {
  const presentation=sitePresentation(environment??(local?'local':undefined));
  const api = useMemo(() => client(getToken), [getToken]);
  const [workspace, setWorkspace] = useState<Workspace | null>();
  const [error, setError] = useState('');
  const [page, setPage] = useState(() => browserSubscriptionEntry().subscription ? 'subscription' : 'overview');
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const load = useCallback(async () => { setError(''); try { setWorkspace(await api.call<Workspace | null>('workspace.get', {})); } catch (e) { setWorkspace(undefined); setError(message(e)); } }, [api]);
  useEffect(() => { void load(); }, [load]);
  const navigate = (next: string) => {
    const entry=browserSubscriptionEntry();
    if(next==='subscription')window.history.replaceState(null,'',subscriptionUrl(entry.plan));
    else if(entry.subscription)window.history.replaceState(null,'','/');
    setSelected(null); setPage(next);
  };
  if(workspace===undefined) return <><Header account={account}/><main id="main" className="main"><section className="card" aria-label="Workspace access"><p>{error ? 'Your workspace could not load.' : 'Loading your workspace…'}</p><Alert error={error}/>{error && <button className="btn" onClick={()=>void load()}>Retry</button>}</section></main></>;
  if(workspace && !workspace.canManageConnections) return <MemberPortal api={api} workspace={workspace} account={account} />;
return <><a href="#main" className="skip-link">Skip to content</a><Header account={account ?? <span className="badge">Local test workspace</span>} /><div className="app-layout"><aside className="sidebar"><span className="eyebrow">Your workspace</span><strong>{workspace?.name ?? 'Welcome'}</strong><nav aria-label="Main navigation">{[['overview', 'Overview'], ['campaigns', 'Campaigns'], ['delivery','Delivery'], ['audience', 'Audience'], ['media', 'Image library'], ['subscription','Subscription'], ['team','Team'], ['support','Support'], ['privacy','Data & privacy'], ['connections', 'API & MCP'], ['settings', 'Workspace'], ['operations','Operations']].map(([id, title]) => <button key={id} className="nav-link" disabled={editorDirty} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id!)}>{title}</button>)}</nav><p className="help">Made for small businesses.<br />Built for thoughtful mail.</p></aside><main id="main" className="main"><div className="notice">{presentation.workspaceNotice}</div><Alert error={error} />{workspace === null ? <Onboarding api={api} done={async()=>{await load();navigate('subscription');}} /> : <>{page === 'overview' && <><Overview workspace={workspace} navigate={navigate} /><WorkspaceSetupProgress api={api} workspace={workspace} onNavigate={navigate}/></>}{page === 'campaigns' && (selected ? <Editor key={selected.id} api={api} initial={selected} onDirty={setEditorDirty} back={() => setSelected(null)} /> : <Campaigns api={api} brands={workspace.brands} open={setSelected} />)}{page === 'audience' && <Audience api={api} brands={workspace.brands} onSetup={() => navigate('connections')} />}{page === 'media' && <WorkspaceMedia api={api} brands={workspace.brands} />}{page === 'connections' && <Connections api={api} workspace={workspace} />}{page === 'team' && <><TeamLifecycle api={api}/><Team api={api} brands={workspace.brands}/></>}{page==='delivery'&&<CustomerDeliveryPanel api={api} brands={workspace.brands} canChooseProvider={workspace.canManageConnections}/>} {page==='subscription'&&<SubscriptionLifecycle api={api} initialPlan={browserSubscriptionEntry().plan} returnedFromStripe={Boolean(browserSubscriptionEntry().billingReturn)} onPlanChange={plan=>window.history.replaceState(null,'',subscriptionUrl(plan))}/>} {page==='support'&&<SupportPortal api={api}/>} {page==='privacy'&&<DataRetention api={api}/>} {page==='operations'&&<><CustomerOperations api={api}/><InfrastructureSetup api={api} brands={workspace.brands}/></>} {page === 'settings' && <><Settings workspace={workspace} environment={presentation.environment} /><WorkspaceAccessPanel api={api}/><Companies api={api} onChanged={load}/><BillingPanel api={api}/><Retention api={api}/><Operations api={api} openCampaign={campaign=>{setSelected(campaign);setPage('campaigns');}}/>{workspace.brands.map(brand=><SenderDomain key={brand.id} api={api} brand={brand}/>)}</>}</>}<footer className="footer">Flockletter · Frosty Flamingo Software · <a href="/help">Email support</a> · <a href="https://github.com/alandmunro/flockletter" target="_blank" rel="noreferrer">Open source, AGPLv3</a></footer></main></div></>;
}
function Onboarding({ api, done }: { api: Api; done: () => Promise<void> }) {
  const [name, setName] = useState(''); const [brand, setBrand] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const key = useRef(operationKey());
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.call('workspace.initialize', { operationKey: key.current, name, brandName: brand }); await done(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="card auth-card"><span className="eyebrow">A good place to begin</span><h1 className="page-heading">Make room for your next idea.</h1><p>Give your workspace and first brand a name. You can prepare your first newsletter before setting up delivery.</p><Alert error={error} /><form onSubmit={submit}><fieldset disabled={busy}><div className="field"><label htmlFor="workspace-name">Workspace name</label><input id="workspace-name" value={name} maxLength={100} required onChange={e => { setName(e.target.value); key.current = operationKey(); }} placeholder="Your business" /></div><div className="field"><label htmlFor="brand-name">Sending brand</label><input id="brand-name" value={brand} maxLength={100} required onChange={e => { setBrand(e.target.value); key.current = operationKey(); }} placeholder="The name readers recognize" /></div><button className="btn" type="submit">{busy ? 'Creating workspace…' : 'Create workspace'}</button></fieldset></form><p className="help">This creates your preparation workspace. It does not start a paid plan or a trial.</p></section>;
}
function Overview({ workspace, navigate }: { workspace: Workspace; navigate: (page: string) => void }) {
  return <><span className="eyebrow">Your next good thing</span><h1 className="page-heading">Hello, {workspace.name}</h1><p className="page-intro">A little planning. A thoughtful message. A reason to stay in touch.</p><section className="hero-card"><div><span className="eyebrow">Start with your story</span><h2>Something worth opening.</h2><p>Write your first campaign, add your own images, and see exactly what readers will see.</p><button className="btn secondary" onClick={() => navigate('campaigns')}>Create a campaign →</button></div></section><div className="grid"><section className="card"><span className="badge">Ready to use</span><h2>Draft & preview</h2><p>Save your work, review it on any screen, and find setup gaps before sending.</p><button className="btn secondary" onClick={() => navigate('campaigns')}>Open campaigns</button></section><section className="card"><span className="badge">Your original images</span><h2>A library of good things</h2><p>Upload several photos together. Successful files stay saved if another file needs fixing.</p><button className="btn secondary" onClick={() => navigate('media')}>Add images</button></section><section className="card"><span className="badge">Included in every tier</span><h2>Work your way</h2><p>Connect your tools through the API or MCP with the access you choose.</p><button className="btn secondary" onClick={() => navigate('connections')}>Manage connections</button></section></div><section className="card"><h2>Before your first send</h2><p>Campaign delivery requires a verified sender, a confirmed audience, service access and a delivery provider. Review brand signup readiness in API & MCP.</p></section></>;
}
function Campaigns({ api, brands, open,canWrite=true }: { api: Api; brands: Brand[]; open: (campaign: Campaign) => void;canWrite?:boolean }) {
  const [items, setItems] = useState<Campaign[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [loaded, setLoaded] = useState(false);
  const createKey = useRef(operationKey());
  const [brandId,setBrandId]=useState(brands[0]?.id??'');
  const chosen=brands.find(b=>b.id===brandId)??brands[0];
  const load = useCallback(() => api.call<Campaign[]>('campaign.list', {}).then(setItems).catch(e => setError(message(e))).finally(() => setLoaded(true)), [api]);
  useEffect(() => { void load(); }, [load]);
  async function create() { setBusy(true); setError(''); try { const draft = await api.call<Campaign>('campaign.create', { operationKey: createKey.current, brandId: chosen!.id, content: { ...emptyContent(), title: 'Untitled campaign', fromName: chosen!.name, studio: emptyStudio() } }); createKey.current = operationKey(); open(draft); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  return <><div className="actions"><div><span className="eyebrow">One idea at a time</span><h1 className="page-heading">Campaigns</h1></div>{canWrite && brands.length>1 && <div className="editor-brand-select"><label htmlFor="new-campaign-brand">Brand for new campaign</label><select id="new-campaign-brand" value={chosen?.id??''} disabled={busy} onChange={e=>{setBrandId(e.target.value);createKey.current=operationKey();}}>{brands.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></div>}{canWrite && <button className="btn" disabled={busy || !chosen} onClick={() => void create()}>{busy ? 'Creating…' : '+ New campaign'}</button>}</div><Alert error={error} />{canWrite && <Authoring api={api} brands={brands} open={open} />}<section className="card">{!loaded ? <p>Loading campaigns…</p> : items.length === 0 ? <div className="empty"><h2>Your next newsletter starts here.</h2><p>{canWrite?'Create a draft and add your images. Drafts never use a campaign allowance.':'No drafts are available for your brands.'}</p></div> : items.map(c => <article className="campaign-row" key={c.id}><div><h2>{c.content.title || 'Untitled campaign'}</h2><p className="muted">{c.content.subject || 'Add a subject'} · Saved {new Date(c.updatedAt).toLocaleDateString()}</p></div><span className="badge">Draft · v{c.version}</span><button className="btn secondary" onClick={() => open(c)} aria-label={`${canWrite?'Edit':'View'} ${c.content.title || 'untitled campaign'}`}>Open draft</button></article>)}</section></>;
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
function Connections({ api, workspace }: { api: Api; workspace: Workspace }) {
  const [items, setItems] = useState<Connection[]>([]); const [name, setName] = useState(''); const [scopes, setScopes] = useState<Capability[]>(['read']); const [token, setToken] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [brandIds,setBrandIds] = useState<string[]>(() => workspace.brands.slice(0,1).map(b => b.id));
  const key = useRef(operationKey());
  const load = useCallback(() => api.call<Connection[]>('connection.list', {}).then(setItems), [api]);
  useEffect(() => { if (workspace.canManageConnections) void load().catch(e => setError(message(e))); }, [load, workspace.canManageConnections]);
  async function create(e: FormEvent) { e.preventDefault(); setBusy(true); setError(''); setToken(''); try { const result = await api.call<{ token?: string }>('connection.create', { operationKey: key.current, name, scopes, brandIds, expiresInDays: 30 }); if (result.token) setToken(result.token); else setError('This token was already issued and cannot be recovered. Revoke that connection and create a new one.'); key.current = operationKey(); await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function revoke(id: string) { setBusy(true); setError(''); try { await api.call('connection.revoke', { operationKey: operationKey(), id }); setToken(''); await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  return <><span className="eyebrow">Fewer steps, the same care</span><h1 className="page-heading">API & MCP connections</h1><p className="page-intro">Let your tools prepare campaigns with only the access they need. Every tier includes API and MCP access.</p><Alert error={error} />{workspace.canManageConnections ? <section className="card"><h2>Create a connection</h2><form onSubmit={create}><fieldset disabled={busy}><div className="field"><label htmlFor="connection-name">Connection name</label><input id="connection-name" required maxLength={80} value={name} placeholder="My campaign assistant" onChange={e => { setName(e.target.value); key.current = operationKey(); }} /></div><legend className="help">Choose access. Expires in 30 days.</legend><fieldset><legend>Brands</legend>{workspace.brands.map(b => <label className="asset-option" key={b.id}><input type="checkbox" checked={brandIds.includes(b.id)} onChange={e => { setBrandIds(current => e.target.checked ? [...current,b.id] : current.filter(id => id !== b.id)); key.current=operationKey(); }} />{b.name}</label>)}</fieldset>{([['read', 'Read drafts, previews and images'], ['audience:write','Import authorized contacts and queue confirmation (brand-scoped; no private confirmation tokens)'], ['audience:confirm','Subscribe selected contacts or imports without email verification, based on recorded permission (separate access)'], ['delivery:configure','Choose AWS SES or Resend for allowed brands (also select draft read; does not grant sending)'], ['campaign:send','Review, approve and schedule campaign delivery (also select draft read)'], ['draft:write', 'Create and edit drafts'], ['assets:write', 'Upload images'], ['audience:summary','Read audience totals by status'],['campaign:rehearse','Review and run local campaign rehearsals'],['campaign:simulate','Run feedback tests that can suppress test contacts, or use an operator-configured AWS simulator (also select draft read and rehearsals)']] as [Capability, string][]).map(([scope, label]) => <label className="asset-option" key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={e => { setScopes(current => e.target.checked ? [...current, scope] : current.filter(s => s !== scope)); key.current = operationKey(); }} />{label}</label>)}<button className="btn" disabled={scopes.length === 0 || brandIds.length === 0 || brandIds.length > 5} type="submit">Create connection</button></fieldset></form>{token && <div className="notice success" role="status"><strong>Copy this token now. It is shown only once.</strong><pre className="token-output">{token}</pre><button className="btn secondary" onClick={() => setToken('')}>I have saved it securely</button></div>}</section> : <p>Workspace owners manage connections.</p>}{workspace.canManageConnections && workspace.brands.map(brand => <IntakePanel key={brand.id} api={api} brand={brand} onIssued={load} />)}<section className="card" id="workspace-connections"><h2>Your connections</h2>{items.length ? items.map(c => <article className="connection-row" key={c.id}><div><strong>{c.name}</strong><p className="help">{c.scopes.join(', ')} · {c.revokedAt ? 'Revoked' : `Expires ${new Date(c.expiresAt).toLocaleDateString()}`}</p></div>{!c.revokedAt && <button className="btn danger" disabled={busy} onClick={() => void revoke(c.id)}>Revoke</button>}</article>) : <p>No connections yet.</p>}<p className="help">Tokens cannot change members, billing or other connections. Removing an issuing owner also removes the connection’s authority.</p></section><section className="card"><h2>Connect your assistant</h2><p>Use the Flockletter MCP bridge with your connection token and an optional photo folder. Keep the token in the host’s secure environment settings.</p><a href="https://github.com/alandmunro/flockletter/blob/codex/foundation-workflow/docs/implementation/API_MCP.md" target="_blank" rel="noreferrer">API & MCP setup guide →</a></section></>;
}
function Settings({ workspace,environment }: { workspace: Workspace;environment?:string }) {
  return <><span className="eyebrow">Clear from the start</span><h1 className="page-heading">Your workspace</h1><section className="card"><h2>{workspace.name}</h2><p>Brand: {workspace.brands.map(b => b.name).join(', ')}</p><p className="badge">{workspace.accessLabel??(workspace.entitlement==='complimentary'?'Complimentary access':'Preparation access')}</p><p>Clerk manages sign-in and workspace membership. Owners manage brand access in Team and review delivery and billing setup below.</p><p>First-party signups require email confirmation. Open and click tracking stay off.</p></section><p><a href="/operator">Open platform control room →</a></p><h2>Hosted plans and shared allowances</h2><p>Allowances are shared across every company and brand in a subscription. Subscription shows this workspace’s recorded service and trial state.</p><PlanCards catalog={workspace.plans} headingLevel={3}/><p className="help">The ordinary trial is 14 days, requires a card, and includes at most 250 active contacts and 500 total emails including tests. {sitePresentation(environment).trialNote}</p></>;
}

function MemberPortal({api,workspace,account}:{api:Api;workspace:Workspace;account?:ReactNode}){
  const [tab,setTab]=useState<'campaigns'|'media'>('campaigns'),[draft,setDraft]=useState<Campaign|null>(null),[dirty,setDirty]=useState(false);
  const writable=workspace.canEdit===true;
  return <><a href="#main" className="skip-link">Skip to content</a><Header account={account}/><div className="app-layout"><aside className="sidebar"><strong>{workspace.name}</strong><nav aria-label="Main navigation">
    <button className="nav-link" disabled={dirty} aria-current={tab==='campaigns'?'page':undefined} onClick={()=>{setDraft(null);setTab('campaigns');}}>Campaigns</button>
    <button className="nav-link" disabled={dirty} aria-current={tab==='media'?'page':undefined} onClick={()=>{setDraft(null);setTab('media');}}>Image library</button></nav></aside>
    <main id="main" className="main"><p className="notice">{writable?'Editor':'Viewer'} access · {workspace.brands.map(b=>b.name).join(', ')}</p>
    {tab==='campaigns'?(draft?(writable?<Editor api={api} initial={draft} onDirty={setDirty} rehearse={false} back={()=>setDraft(null)}/>:<DraftReader api={api} draft={draft} back={()=>setDraft(null)}/>):<Campaigns api={api} brands={workspace.brands} open={setDraft} canWrite={writable}/>):<WorkspaceMedia api={api} brands={workspace.brands} canWrite={writable}/>}</main></div></>;
}
