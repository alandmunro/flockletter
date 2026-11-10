import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request} from 'express';
import type {Authenticator} from '../src/server/auth.js';
import {loadConfig} from '../src/server/config.js';
import {platformIdentity} from '../src/server/platform/auth.js';
import {operatorMfaPolicy,currentFirstFactor} from '../src/server/platform/auth-policy.js';

const clerk=vi.hoisted(()=>({authenticateRequest:vi.fn(),getSession:vi.fn(),getUser:vi.fn(),membership:vi.fn()}));
vi.mock('@clerk/backend',()=>({createClerkClient:()=>({authenticateRequest:clerk.authenticateRequest,sessions:{getSession:clerk.getSession},users:{getUser:clerk.getUser},organizations:{getOrganizationMembershipList:clerk.membership}})}));
const env={APP_ENV:'production',APP_ORIGIN:'https://app.example.test',CLERK_PUBLISHABLE_KEY:'pk_live_synthetic',CLERK_SECRET_KEY:'sk_live_synthetic',FLOCKLETTER_OPERATOR_ORGANIZATION_ID:'org_operators',FLOCKLETTER_OPERATOR_USER_IDS:'user_operator'};
const config=loadConfig(env),auth={} as Authenticator;
const request={get:(name:string)=>name==='authorization'?'Bearer header.payload.signature':undefined,originalUrl:'/api/operator/v1/commands/platform.overview'} as Request;
const signed=(ages:unknown=[0,-1])=>({userId:'user_operator',sessionId:'sess_operator',orgId:'org_operators',factorVerificationAge:ages});
const identity=(policy='pre-revenue')=>platformIdentity(config,auth,'live',{...env,FLOCKLETTER_OPERATOR_MFA_POLICY:policy});
beforeEach(()=>{
  vi.clearAllMocks();
  clerk.authenticateRequest.mockResolvedValue({toAuth:()=>signed()});
  clerk.getSession.mockResolvedValue({status:'active',userId:'user_operator'});
  clerk.getUser.mockResolvedValue({twoFactorEnabled:false});
  clerk.membership.mockResolvedValue({data:[{publicUserData:{userId:'user_operator'},role:'org:admin'}]});
});

describe('explicit temporary operator policy',()=>{
  it('defaults to MFA and rejects unknown/empty policies',()=>{
    expect(operatorMfaPolicy('production',{})).toBe('required');
    for(const value of ['','optional','false',' pre-revenue '])expect(()=>operatorMfaPolicy('production',{FLOCKLETTER_OPERATOR_MFA_POLICY:value})).toThrow();
  });
  it('rejects the exception outside production and before opening any hosted connection',()=>{
    for(const APP_ENV of ['staging','test','local'])expect(()=>loadConfig({...env,APP_ENV,FLOCKLETTER_OPERATOR_MFA_POLICY:'pre-revenue'})).toThrow('requires production');
  });
  it.each([
    ['FLOCKLETTER_RETENTION_SIGNING_ENABLED','approved'],['FLOCKLETTER_CUSTOMER_RETENTION','live'],
  ])('refuses %s=%s even while platform access is off', (key,value)=>{
    expect(()=>loadConfig({...env,FLOCKLETTER_OPERATOR_MFA_POLICY:'pre-revenue',FLOCKLETTER_PLATFORM_MODE:'off',[key]:value})).toThrow('hosted retention and signing off');
  });
  it('does not make the Clerk upgrade a prerequisite to a first paid customer',()=>{
    expect(loadConfig({...env,FLOCKLETTER_OPERATOR_MFA_POLICY:'pre-revenue',FLOCKLETTER_CUSTOMER_BILLING:'stripe_live',FLOCKLETTER_LIVE_BILLING_APPROVED:'true'}).operatorMfaPolicy).toBe('pre-revenue');
    expect(operatorMfaPolicy('production',{FLOCKLETTER_OPERATOR_MFA_POLICY:'pre-revenue',FLOCKLETTER_BILLING_MODE:'sandbox'})).toBe('pre-revenue');
  });
  it('permits required policy with live-billing configuration for its separate checks',()=>{
    expect(loadConfig({...env,FLOCKLETTER_CUSTOMER_BILLING:'stripe_live'}).operatorMfaPolicy).toBe('required');
  });
  it('accepts only a recent well-formed first factor; absent second factor is deliberate',()=>{
    expect(currentFirstFactor([0,-1])).toBe(true);
    expect(currentFirstFactor([4.99,500])).toBe(true);
    for(const value of [null,[],[0],[0,-2],[0,-0.5],[0,NaN],[0,Infinity],[0,'0'],[NaN,-1],[Infinity,-1],[-1,-1],[5,-1],['0',-1],[0,-1,0]])expect(currentFirstFactor(value)).toBe(false);
  });
});

describe('actual live identity boundary using synthetic Clerk responses',()=>{
  it('accepts no enrolled second factor only with the explicit exception',async()=>{
    const selected=identity(),session=await selected.authenticate(request);
    expect(session).toMatchObject({exercise:false,authentication:'pre-revenue',userId:'user_operator',sessionId:'sess_operator'});
    expect(selected.mfaPolicy).toBe('pre-revenue');
    expect(await selected.current(session)).toBe(true);
    expect(clerk.authenticateRequest).toHaveBeenCalledWith(expect.any(globalThis.Request),{authorizedParties:config.browserOrigins,acceptsToken:'session_token'});
    await expect(identity('required').authenticate(request)).rejects.toMatchObject({code:'operator_mfa_enrollment_required'});
  });
  it('uses first-factor age rather than absent second-factor sentinel or current time',async()=>{
    clerk.authenticateRequest.mockResolvedValue({toAuth:()=>signed([3,-1])});
    const before=Date.now(),session=await identity().authenticate(request);
    expect(Date.parse(session.verifiedAt)).toBeGreaterThanOrEqual(before-180000);
    expect(Date.parse(session.verifiedAt)).toBeLessThanOrEqual(Date.now()-180000);
  });
  it('requires first-factor reverification at the five-minute boundary',async()=>{
    clerk.authenticateRequest.mockResolvedValue({toAuth:()=>signed([5,0])});
    await expect(identity().authenticate(request)).rejects.toMatchObject({code:'operator_first_factor_required'});
  });
  it('still requires both fresh factors under the default MFA policy',async()=>{
    clerk.getUser.mockResolvedValue({twoFactorEnabled:true});
    clerk.authenticateRequest.mockResolvedValue({toAuth:()=>signed([0,-1])});
    await expect(identity('required').authenticate(request)).rejects.toMatchObject({code:'operator_mfa_required'});
    clerk.authenticateRequest.mockResolvedValue({toAuth:()=>signed([0,1])});
    expect(await identity('required').authenticate(request)).toMatchObject({authentication:'required'});
  });
  it.each(['required','pre-revenue'])('does not accept customer connection credentials in %s mode',async policy=>{
    await expect(identity(policy).authenticate({...request,get:()=> 'Bearer flk_customer.secret'} as unknown as Request)).rejects.toMatchObject({code:'operator_sign_in_required'});
    expect(clerk.authenticateRequest).not.toHaveBeenCalled();
  });
  it.each(['required','pre-revenue'])('preserves the dedicated organization and named operator gates in %s mode',async policy=>{
    clerk.authenticateRequest.mockResolvedValue({toAuth:()=>({...signed(),orgId:'org_customer'})});
    await expect(identity(policy).authenticate(request)).rejects.toMatchObject({code:'operator_required'});
    clerk.authenticateRequest.mockResolvedValue({toAuth:()=>({...signed(),userId:'user_stranger'})});
    clerk.getSession.mockResolvedValue({status:'active',userId:'user_stranger'});
    await expect(identity(policy).authenticate(request)).rejects.toMatchObject({code:'operator_required'});
  });
  it.each(['required','pre-revenue'])('preserves active session, user binding and current admin membership in %s mode',async policy=>{
    const selected=identity(policy);
    for(const session of [{status:'revoked',userId:'user_operator'},{status:'active',userId:'user_other'}]){
      clerk.getSession.mockResolvedValue(session);
      await expect(selected.authenticate(request)).rejects.toMatchObject({code:'operator_required'});
    }
    clerk.getSession.mockResolvedValue({status:'active',userId:'user_operator'});
    clerk.membership.mockResolvedValue({data:[{publicUserData:{userId:'user_operator'},role:'org:member'}]});
    await expect(selected.authenticate(request)).rejects.toMatchObject({code:'operator_required'});
  });
  it('rechecks revocation, membership, expiry and assurance when a case authorizes later work',async()=>{
    const selected=identity(),session=await selected.authenticate(request);
    expect(await selected.current({...session,authentication:'required'})).toBe(false);
    expect(await selected.current({...session,verifiedAt:new Date(Date.now()-300000).toISOString()})).toBe(false);
    expect(await selected.current({...session,exercise:true})).toBe(false);
    expect(await identity('required').current(session)).toBe(false);
    clerk.getSession.mockResolvedValue({status:'revoked',userId:'user_operator'});
    expect(await selected.current(session)).toBe(false);
    clerk.getSession.mockResolvedValue({status:'active',userId:'user_operator'});
    clerk.membership.mockResolvedValue({data:[]});
    expect(await selected.current(session)).toBe(false);
  });
});
