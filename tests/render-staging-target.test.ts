import {describe,expect,it} from 'vitest';
// @ts-expect-error - plain ESM without type declarations
import {stagingTargetMatches} from '../scripts/verify-render-staging-target.mjs';

const repository='https://github.com/example/flockletter';
const stagingUrl='https://flockletter-staging.example.test';
const serviceId=`srv-${'s'.repeat(20)}`;
function base(){
  return {
    version:{appId:'flockletter',environment:'staging'} as Record<string,unknown>|null,
    web:{id:serviceId,type:'web_service',repo:repository,branch:'main',autoDeploy:'no',suspended:'not_suspended',serviceDetails:{url:stagingUrl}} as Record<string,unknown>,
  };
}
const options={repository,stagingUrl,serviceId};

describe('stagingTargetMatches',()=>{
  it('accepts Flockletter staging, awake or asleep',()=>{
    expect(stagingTargetMatches(base(),options)).toBe(true);
    expect(stagingTargetMatches({...base(),version:null},options)).toBe(true);
  });
  it.each<[string,(i:ReturnType<typeof base>)=>void]>([
    ['production application',i=>{i.version={appId:'flockletter',environment:'production'}}],
    ['another application',i=>{i.version={appId:'cadence',environment:'staging'}}],
    ['another service id',i=>{i.web.id=`srv-${'x'.repeat(20)}`}],
    ['a worker',i=>{i.web.type='background_worker'}],
    ['another repository',i=>{i.web.repo='https://github.com/example/other'}],
    ['another branch',i=>{i.web.branch='dev'}],
    ['automatic deploys',i=>{i.web.autoDeploy='yes'}],
    ['a suspended service',i=>{i.web.suspended='suspended'}],
    ['another address',i=>{i.web.serviceDetails={url:'https://flockletter-production.example.test'}}],
  ])('refuses %s',(_name,change)=>{
    const input=base();change(input);
    expect(stagingTargetMatches(input,options)).toBe(false);
  });
  it('refuses malformed options',()=>{
    expect(stagingTargetMatches(base(),{...options,stagingUrl:'http://flockletter-staging.example.test'})).toBe(false);
    expect(stagingTargetMatches(base(),{...options,serviceId:'srv-short'})).toBe(false);
    expect(stagingTargetMatches(base(),{...options,repository:'https://example.com/x/y'})).toBe(false);
  });
});
