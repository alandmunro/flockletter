import {expect,it} from 'vitest';
import {supportResendKeys} from '../src/server/customer-support/configuration.js';

it('does not require provider credentials for disabled or captured support',()=>{
  expect(supportResendKeys({},false)).toEqual({sending:undefined,retrieval:undefined});
});
it('requires distinct send and retrieval credentials for live support',()=>{
  expect(()=>supportResendKeys({},true)).toThrow('separate sending and retrieval');
  expect(()=>supportResendKeys({FLOCKLETTER_SUPPORT_RESEND_KEY:'send-fixture'},true)).toThrow('separate sending and retrieval');
  expect(()=>supportResendKeys({FLOCKLETTER_SUPPORT_RESEND_KEY:'same-fixture',FLOCKLETTER_SUPPORT_RESEND_RETRIEVE_KEY:'same-fixture'},true)).toThrow('different Resend credentials');
  expect(supportResendKeys({FLOCKLETTER_SUPPORT_RESEND_KEY:'send-fixture',FLOCKLETTER_SUPPORT_RESEND_RETRIEVE_KEY:'retrieve-fixture'},true))
    .toEqual({sending:'send-fixture',retrieval:'retrieve-fixture'});
});
it('never reuses sending credentials when native receipt intake is declared',()=>{
  expect(()=>supportResendKeys({FLOCKLETTER_SUPPORT_RESEND_KEY:'send-fixture',FLOCKLETTER_SUPPORT_NATIVE_WEBHOOK_SECRET:'webhook-fixture'},false))
    .toThrow('dedicated retrieval');
});
