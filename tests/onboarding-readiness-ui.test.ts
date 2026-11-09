import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {OnboardingProgress} from '../src/client/OnboardingProgress.js';
import type {WorkspacePreflight} from '../src/shared/workspace-preflight.js';
import {limits} from '../src/shared/contracts.js';

const baseReadiness:WorkspacePreflight={initialized:true,canPrepare:true,canSend:false,reviewRequired:true,mode:'ses',capturedExercise:false,rendererConfigured:true,observedAt:'2025-01-01T00:00:00Z',scopes:['read'],brandIds:null,limits,allowance:null,service:{source:'stripe',state:'active',eligible:true,reasons:[]},brands:[{id:'brand-a',name:'Alpine',confirmed:2,senderProfileConfigured:true,senderVerified:true}],gaps:[]};
const workspace={name:'Shop',brands:[{id:'brand-a',name:'Alpine'}],entitlement:'not_activated' as const};
const noop=()=>{};
const render=(readiness:WorkspacePreflight)=>renderToStaticMarkup(createElement(OnboardingProgress,{workspace,hasDraft:false,readiness,onNavigate:noop}));

describe('OnboardingProgress',()=>{
  it('shows active Stripe service from canonical data despite entitlement not activated',()=>{
    expect(render(baseReadiness)).toContain('active');
  });
  it('does not show current verified when service null and senderVerified false',()=>{
    const readiness:WorkspacePreflight={...baseReadiness,service:null,brands:[{id:'brand-a',name:'Alpine',confirmed:2,senderProfileConfigured:true,senderVerified:false}]};
    expect(render(readiness)).not.toContain('Current at this check');
  });
  it('labels exercise only for capture mode with sender false',()=>{
    const readiness:WorkspacePreflight={...baseReadiness,mode:'capture' as const,capturedExercise:true,service:{source:'exercise',state:'active',eligible:true,reasons:[]},brands:[{id:'brand-a',name:'Alpine',confirmed:2,senderProfileConfigured:true,senderVerified:false}]};
    const html=render(readiness);
    expect(html).toContain('Exercise only');
    expect(html).not.toContain('Current at this check');
  });
  it('never carries verified success for unknown/error state',()=>{
    const html=renderToStaticMarkup(createElement(OnboardingProgress,{workspace,readiness:baseReadiness,error:'Synthetic unavailable',onNavigate:noop}));
    expect(html).toContain('Synthetic unavailable');
    expect(html).toContain('Not checked');
    expect(html).not.toContain('Current at this check');
  });
  it('shows gap detail and action button; audience null unavailable',()=>{
    const readiness:WorkspacePreflight={...baseReadiness,brands:[{id:'brand-a',name:'Alpine',confirmed:null,senderProfileConfigured:true,senderVerified:false}],gaps:[{code:'audience',title:'Audience needed',detail:'Add contacts.',brandId:'brand-a',action:'audience'}]};
    const html=render(readiness);
    expect(html).toContain('Add contacts.');
    expect(html).toContain('Open Audience');
    expect(html).toContain('Not available with this access');
  });
  it('displays multiple brands each with own sender state and count',()=>{
    const readiness:WorkspacePreflight={...baseReadiness,brands:[{id:'b1',name:'One',confirmed:5,senderProfileConfigured:true,senderVerified:true},{id:'b2',name:'Two',confirmed:0,senderProfileConfigured:false,senderVerified:false}]};
    const html=render(readiness);
    expect(html).toContain('One');
    expect(html).toContain('Two');
    expect(html).toContain('5 confirmed contacts');
    expect(html).toContain('0 confirmed contacts');
  });
});
