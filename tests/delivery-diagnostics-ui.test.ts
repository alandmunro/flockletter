import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {DeliveryDiagnostics} from '../src/client/DeliveryDiagnostics.js';
import type {CustomerDeliveryStatus} from '../src/shared/customer-delivery.js';

const brand={id:'00000000-0000-4000-8000-000000000001',name:'Trail'};
const campaign={id:'00000000-0000-4000-8000-000000000002',version:6,title:'Trail announcement'};
const status={context:{environment:'production',workspaceId:'org_example',observedAt:'2026-11-12T00:00:00Z'},mode:'resend',scope:'tests',rendererConfigured:true,providerConfigured:true,senderVerified:true} as CustomerDeliveryStatus;
const render=(change:Partial<CustomerDeliveryStatus>={},draft:typeof campaign|null=campaign)=>renderToStaticMarkup(createElement(DeliveryDiagnostics,{status:{...status,...change},brand,campaign:draft}));

it('shows exact current support context without actions or claiming a send',()=>{
 const html=render();
 for(const text of ['org_example','production',brand.id,campaign.id,'Resend','Single-contact tests','<dt>Saved version</dt><dd>6</dd>'])expect(html).toContain(text);
 expect(html).not.toContain('<button');expect(html).not.toContain('<details open');
 expect(html).toContain('verify the sign-in account, workspace and environment');
});
it('does not invent a missing saved campaign or infer it exists elsewhere',()=>{
 const html=render({},null);expect(html).toContain('No saved campaign selected');expect(html).not.toContain(campaign.id);
});
it.each([null,false,true] as const)('distinguishes provider state %s',value=>{
 const label=value===null?'Unknown':value?'Yes':'No';
 expect(render({providerConfigured:value})).toContain('<dt>This service provider route configured</dt><dd>'+label+'</dd>');
});
it('escapes authored campaign titles',()=>{
 const html=render({}, {...campaign,title:'<script>alert("xss")</script>'});
 expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');
});
