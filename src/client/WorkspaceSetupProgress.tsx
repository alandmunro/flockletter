import {useCallback,useEffect,useRef,useState} from 'react';
import type {Workspace} from '../shared/contracts.js';
import type {SetupPage,WorkspacePreflight} from '../shared/workspace-preflight.js';
import type {Api} from './api.js';
import {OnboardingProgress} from './OnboardingProgress.js';

/** Owner shell only. Members retain their existing preparation UI and never call owner commands here. */
export function WorkspaceSetupProgress({api,workspace,onNavigate}:{api:Api;workspace:Workspace;onNavigate:(page:SetupPage)=>void}) {
  const [readiness,setReadiness]=useState<WorkspacePreflight>(),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const request=useRef(0);
  const refresh=useCallback(async()=>{
    const current=++request.current;setLoading(true);setError('');setReadiness(undefined);
    try {const value=await api.call<WorkspacePreflight>('workspace.preflight',{});if(current===request.current)setReadiness(value);}
    catch(error){if(current===request.current)setError(error instanceof Error?error.message:'Workspace setup could not be checked.');}
    finally{if(current===request.current)setLoading(false);}
  },[api]);
  useEffect(()=>{void refresh();return()=>{request.current++;};},[refresh]);
  const brands = readiness?.brands;
  const confirmed = brands && brands.every(brand => brand.confirmed !== null)
    ? brands.reduce((total, brand) => total + (brand.confirmed ?? 0), 0) : undefined;
  const tiles: {label: string; value: number | undefined; page: SetupPage}[] = [
    {label: 'Sending brands', value: workspace.brands.length, page: 'settings'},
    {label: 'Confirmed contacts across brands', value: confirmed, page: 'audience'},
    {label: 'Sender profiles configured', value: brands?.filter(brand => brand.senderProfileConfigured).length, page: 'delivery'},
  ];
  return <><div className="overview-tiles">{tiles.map(tile =>
    <button type="button" key={tile.page} onClick={() => onNavigate(tile.page)}>
      <span>{tile.label}</span><b>{tile.value?.toLocaleString() ?? (loading ? 'Checking…' : 'Unavailable')}</b>
      <i aria-hidden="true">↗</i>
    </button>
  )}</div><OnboardingProgress workspace={workspace} hasDraft={workspace.hasDraft} readiness={readiness}
    loading={loading} error={error} onRefresh={()=>void refresh()} onNavigate={onNavigate}/></>;
}
