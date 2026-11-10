import {describe,expect,it} from 'vitest';
// @ts-expect-error - plain ESM without type declarations
import {productionTargetsMatch} from '../scripts/verify-render-production-targets.mjs';

const repo='https://github.com/example/flockletter';
const url='https://flockletter.example.test';
const webId=`srv-${'a'.repeat(20)}`;
const workerId=`srv-${'b'.repeat(20)}`;
const ownerId='o-1';
const envId='e-1';

function base(){
  return {
    version:{appId:'flockletter',environment:'production'},
    web:{id:webId,type:'web_service',repo,branch:'main',autoDeploy:'no',suspended:'not_suspended',ownerId,environmentId:envId,serviceDetails:{numInstances:1,url,region:'oregon'}},
    worker:{id:workerId,type:'background_worker',repo,branch:'main',autoDeploy:'no',suspended:'not_suspended',ownerId,environmentId:envId,serviceDetails:{numInstances:1,region:'oregon',envSpecificDetails:{startCommand:'node dist/server/server/customer-worker-main.js'}}}
  };
}

describe('productionTargetsMatch',()=>{
  it('accepts the valid fixture and does not mutate input',()=>{
    const input=base();
    const snapshot=structuredClone(input);
    expect(productionTargetsMatch(input,{repository:repo,productionUrl:url,webId,workerId})).toBe(true);
    expect(input).toEqual(snapshot);
  });

  it.each<[string,(input:ReturnType<typeof base>)=>void]>([
    ['staging application cannot be production',i=>{i.version.environment='staging'}],
    ['foreign application cannot be production',i=>{i.version.appId='other'}],
    ['wrong web id',i=>{i.web.id=`srv-${'c'.repeat(20)}`}],
    ['wrong worker id',i=>{i.worker.id=`srv-${'d'.repeat(20)}`}],
    ['wrong web type',i=>{i.web.type='x'}],
    ['wrong worker type',i=>{i.worker.type='y'}],
    ['foreign repo web',i=>{i.web.repo='https://github.com/example/other'}],
    ['foreign repo worker',i=>{i.worker.repo='https://github.com/example/other'}],
    ['owner mismatch',i=>{i.worker.ownerId='o-2'}],
    ['empty env id web',i=>{i.web.environmentId='  '}],
    ['env mismatch',i=>{i.worker.environmentId='e-2'}],
    ['web replicas exceed the role budget',i=>{i.web.serviceDetails.numInstances=2}],
    ['worker replicas exceed the role budget',i=>{i.worker.serviceDetails.numInstances=2}],
    ['region mismatch',i=>{i.worker.serviceDetails.region='us-east-1'}],
    ['web autoDeploy yes',i=>{i.web.autoDeploy='yes'}],
    ['worker autoDeploy yes',i=>{i.worker.autoDeploy='yes'}],
    ['worker wrong command',i=>{i.worker.serviceDetails.envSpecificDetails.startCommand='node dist/other.js'}],
    ['worker suspended',i=>{i.worker.suspended='suspended'}],
    ['web branch other',i=>{i.web.branch='dev'}],
    ['worker branch other',i=>{i.worker.branch='dev'}],
  ])('rejects %s',(name,mutate)=>{
    const input=base();
    mutate(input);
    expect(productionTargetsMatch(input,{repository:repo,productionUrl:url,webId,workerId}),name).toBe(false);
  });

  it('rejects same web and worker IDs',()=>{
    const input=base();
    input.worker.id=input.web.id;
    expect(productionTargetsMatch(input,{repository:repo,productionUrl:url,webId,workerId:webId})).toBe(false);
  });

  it.each([
    ['missing application identity',()=>({web:base().web,worker:base().worker})],
    ['missing web',()=>({worker:base().worker})],
    ['missing worker',()=>({web:base().web})],
    ['null input',()=>null],
    ['array input',()=>[1,2]],
  ])('rejects malformed %s',(name,make)=>{
    expect(productionTargetsMatch(make(),{repository:repo,productionUrl:url,webId,workerId}),name).toBe(false);
  });
});

it.each([
  {repository:'https://example.test/other/flockletter'},
  {productionUrl:'http://flockletter.example.test'},
  {productionUrl:'https://flockletter.example.test/path'},
  {webId:'srv-malformed'},
  {workerId:'srv-malformed'},
])('rejects malformed or foreign expected destinations: %j',overrides=>{
  expect(productionTargetsMatch(base(),{repository:repo,productionUrl:url,webId,workerId,...overrides})).toBe(false);
});
