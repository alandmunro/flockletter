import { createClerkClient } from '@clerk/backend';
import type { Request as ExpressRequest } from 'express';
import type { Config } from '../config.js';
import type { Authenticator } from '../auth.js';
import { requireCondition } from '../errors.js';

export type OperatorSession={userId:string;sessionId:string;verifiedAt:string;workspaceId?:string;exercise:boolean};
export interface OperatorIdentity { authenticate(request:ExpressRequest):Promise<OperatorSession>; current(session:OperatorSession):Promise<boolean>; }
export const MFA_MAX_AGE_MS=5*60000;
export function currentMfa(ages:unknown,enabled:boolean){return enabled&&Array.isArray(ages)&&ages.length===2&&ages.every(v=>Number.isFinite(v)&&v>=0&&v<5);}
export function platformIdentity(config:Config,auth:Authenticator,mode:'capture'|'live',env:NodeJS.ProcessEnv):OperatorIdentity {
  if(mode==='capture')return {
    async authenticate(request){const actor=await auth.authenticate(request);requireCondition(actor.kind==='session'&&actor.owner&&await auth.identity.isOwner(actor.userId,actor.workspaceId),403,'operator_required','Use a current owner session for this workspace exercise.');return {userId:actor.userId,sessionId:actor.actorId,workspaceId:actor.workspaceId,verifiedAt:new Date().toISOString(),exercise:true};},
    async current(session){return !!session.exercise&&!!session.workspaceId&&await auth.identity.isOwner(session.userId,session.workspaceId);},
  };
  const organization=env.FLOCKLETTER_OPERATOR_ORGANIZATION_ID;
  const allowed=new Set((env.FLOCKLETTER_OPERATOR_USER_IDS??'').split(',').map(v=>v.trim()).filter(Boolean));
  requireCondition(!!organization&&/^org_[A-Za-z0-9_-]+$/.test(organization)&&allowed.size>0,503,'operator_configuration_required','Configure the separate operator organization and named operators.');
  const clerk=createClerkClient({secretKey:config.clerkSecretKey,publishableKey:config.clerkPublishableKey});
  const membership=async(userId:string)=>{if(!allowed.has(userId))return false;const page=await clerk.organizations.getOrganizationMembershipList({organizationId:organization!,userId:[userId],limit:2});return page.data.some(m=>m.publicUserData?.userId===userId&&m.role==='org:admin');};
  return {
    async authenticate(request){
      const bearer=request.get('authorization')??'';
      requireCondition(/^Bearer [^.]+\.[^.]+\.[^.]+$/.test(bearer)&&bearer.length<8192,401,'operator_sign_in_required','Use a current Clerk operator session, not a customer connection.');
      const headers=new Headers({authorization:bearer});
      const state=await clerk.authenticateRequest(new Request(config.origin+request.originalUrl,{headers}),{authorizedParties:config.browserOrigins,acceptsToken:'session_token'});
      const signed=state.toAuth();
      requireCondition(signed?.userId&&signed.sessionId&&signed.orgId===organization,403,'operator_required','Select the dedicated platform operator organization.');
      const [session,user,member]=await Promise.all([clerk.sessions.getSession(signed.sessionId),clerk.users.getUser(signed.userId),membership(signed.userId)]);
      requireCondition(session.status==='active'&&session.userId===signed.userId&&member,403,'operator_required','Current named operator membership is required.');
      requireCondition(user.twoFactorEnabled,403,'operator_mfa_enrollment_required','Enable a second sign-in factor in your account before using live operator controls.');
      requireCondition(currentMfa(signed.factorVerificationAge,user.twoFactorEnabled),403,'operator_mfa_required','Verify both sign-in factors within the last five minutes to use operator controls.');
      return {userId:signed.userId,sessionId:signed.sessionId,verifiedAt:new Date(Date.now()-Math.max(...signed.factorVerificationAge!)*60000).toISOString(),exercise:false};
    },
    async current(value){
      if(value.exercise||!Number.isFinite(Date.parse(value.verifiedAt))||Date.now()-Date.parse(value.verifiedAt)>=MFA_MAX_AGE_MS||Date.parse(value.verifiedAt)>Date.now()+30000||!allowed.has(value.userId))return false;
      const [session,user,member]=await Promise.all([clerk.sessions.getSession(value.sessionId),clerk.users.getUser(value.userId),membership(value.userId)]);
      return session.status==='active'&&session.userId===value.userId&&user.twoFactorEnabled&&member;
    },
  };
}
