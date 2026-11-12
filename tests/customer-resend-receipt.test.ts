import {expect,it} from 'vitest';
import {resendReceipt} from '../src/server/customer-delivery/resend.js';

const base={id:'123e4567-e89b-12d3-a456-426614174000',from:'news@sender.example.com',to:['reader@example.com'],tags:[{name:'fl_kind',value:'customer'}]};
const empty=[undefined,null,[]];

it('normalizes omitted, null and empty CC/BCC in every combination',()=>{
 for(const cc of empty)for(const bcc of empty){
  expect(resendReceipt.parse({...base,...(cc===undefined?{}:{cc}),...(bcc===undefined?{}:{bcc})})).toEqual({...base,cc:[],bcc:[]});
 }
});

it.each(['cc','bcc'] as const)('rejects extra or malformed %s without treating them as absent',field=>{
 for(const value of [['other@example.com'],[''],[123],'other@example.com',{},42,true]){
  expect(resendReceipt.safeParse({...base,cc:null,bcc:null,[field]:value}).success).toBe(false);
 }
});

it('still requires exactly one destination and an independently bound receipt',()=>{
 for(const to of [[],['reader@example.com','other@example.com'],['invalid']]){
  expect(resendReceipt.safeParse({...base,cc:null,bcc:null,to}).success).toBe(false);
 }
 expect(resendReceipt.safeParse({...base,cc:null,bcc:null,tags:null}).success).toBe(false);
 expect(resendReceipt.safeParse({...base,cc:null,bcc:null,id:'invalid'}).success).toBe(false);
});
