import type {Capability,limits} from './contracts.js';
import type {CustomerAllowance,CustomerBillingState} from './customer-billing.js';

export type SetupPage='settings'|'campaigns'|'subscription'|'delivery'|'audience'|'operations';
export type WorkspaceSetupGap={code:string;title:string;detail:string;brandId?:string;action:SetupPage};
/** Setup observations never authorize a send; exact review and execution checks are separate. */
export type WorkspacePreflight={
  initialized:boolean;canPrepare:boolean;canSend:false;reviewRequired:true;
  mode:'off'|'capture'|'ses';deliveryScope?:'all'|'tests';capturedExercise:boolean;rendererConfigured:boolean;observedAt:string;
  scopes:Capability[];brandIds:string[]|null;limits:typeof limits;
  allowance:CustomerAllowance|null;
  service:{source:'preparation'|'exercise'|'stripe'|'complimentary';state:CustomerBillingState;eligible:boolean;reasons:string[]}|null;
  brands:{id:string;name:string;confirmed:number|null;senderProfileConfigured:boolean;senderVerified:boolean}[];
  gaps:WorkspaceSetupGap[];
};
