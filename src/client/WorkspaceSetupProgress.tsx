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
  return <OnboardingProgress workspace={workspace} hasDraft={workspace.hasDraft} readiness={readiness}
    loading={loading} error={error} onRefresh={()=>void refresh()} onNavigate={onNavigate}/>;
}
