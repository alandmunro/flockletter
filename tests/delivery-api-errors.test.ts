import {afterEach,expect,it,vi} from 'vitest';
import {ApiError,client} from '../src/client/api.js';
import {explainDeliveryError} from '../src/client/delivery-error.js';
afterEach(()=>vi.unstubAllGlobals());

it('preserves redacted server error code/status without retrying a failed send',async()=>{
 const send=vi.fn(async()=>Response.json({error:{code:'test_already_pending',message:'The original test is pending.'}},{status:409}));
 vi.stubGlobal('fetch',send);const api=client(async()=>'synthetic-session');
 await expect(api.call('delivery.process',{})).rejects.toMatchObject({name:'ApiError',status:409,code:'test_already_pending'});
 expect(send).toHaveBeenCalledTimes(1);
});
it.each([
 ['campaign_unavailable','signed-in workspace'],['version_conflict','exact current version'],['broadcasts_disabled','one intended confirmed contact'],
 ['group_unavailable','do not fall back to all contacts'],['test_daily_limit','Cancellation and failure do not restore'],['test_already_pending','do not approve a replacement'],['operation_conflict','outcome is unknown'],
])('explains %s without broadening or duplicating delivery',(code,help)=>expect(explainDeliveryError(new ApiError(409,code,'Server message.'))).toContain(help));
it('retains unknown error messages and normalizes malformed codes',()=>{
 const error=new ApiError(503,'Invalid code\n','Provider unavailable.');expect(error.code).toBe('request_failed');expect(explainDeliveryError(error)).toBe('Provider unavailable.');
 expect(explainDeliveryError(null)).toContain('original test');
});
