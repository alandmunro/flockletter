import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { inspectStripeBillingConfiguration, billingProviderEvents } from '../src/server/customer-billing/configuration-inspection.js';
import {inspectCustomerBillingEnvironment} from '../scripts/inspect-customer-billing.js';

const target = {account:'acct_fixture',live:false,origin:'https://flockletter.example.test',cardConfiguration:'pmc_fixture',portalConfiguration:'bpc_fixture',planPortalConfigurations:{starter:'bpc_starter',growth:'bpc_growth',pro:'bpc_pro'},prices:{starter:'price_starter',growth:'price_growth',pro:'price_pro'}};

function buildFixture(
  mutate?: (endpoint: string, data: Record<string, unknown>) => void, failPath?:string,
) {
  const calls: Array<{ method: string; path: string; host:string; search:URLSearchParams }> = [];

  const product = {
    id: 'prod_flockletter',
    object: 'product',
    active: true,
    livemode: false,
    deleted: null,
    metadata: { fl_application: 'flockletter' },
  };

  const prices: Record<string, unknown> = {
    price_starter: {
      id: 'price_starter',
      object: 'price',
      active: true,
      livemode: false,
      currency: 'usd',
      unit_amount: 1500,
      unit_amount_decimal: '1500',
      billing_scheme: 'per_unit',
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
      metadata: { fl_application: 'flockletter', fl_plan: 'starter' },
      product,
    },
    price_growth: {
      id: 'price_growth',
      object: 'price',
      active: true,
      livemode: false,
      currency: 'usd',
      unit_amount: 2500,
      unit_amount_decimal: '2500',
      billing_scheme: 'per_unit',
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
      metadata: { fl_application: 'flockletter', fl_plan: 'growth' },
      product,
    },
    price_pro: {
      id: 'price_pro',
      object: 'price',
      active: true,
      livemode: false,
      currency: 'usd',
      unit_amount: 3900,
      unit_amount_decimal: '3900',
      billing_scheme: 'per_unit',
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
      metadata: { fl_application: 'flockletter', fl_plan: 'pro' },
      product,
    },
  };

  const map: Record<string, unknown> = {
    '/v1/account': { id: 'acct_fixture' },
    '/v1/payment_method_configurations/pmc_fixture': {
      id: 'pmc_fixture',
      active: true,
      livemode: false,
      card: { available: true, display_preference: { value: 'on' } },
    },
    '/v1/billing_portal/configurations/bpc_fixture': {
      id: 'bpc_fixture',
      active: true,
      is_default: false,
      livemode: false,
      metadata: { fl_application: 'flockletter' },
      default_return_url: 'https://flockletter.example.test/',
      login_page: { enabled: false },
      features: {
        customer_update: { enabled: false },
        invoice_history: { enabled: true },
        payment_method_update: {
          enabled: true,
          payment_method_configuration: 'pmc_fixture',
        },
        subscription_cancel: {
          enabled: true,
          mode: 'at_period_end',
          proration_behavior: 'none',
        },
        subscription_pause: { enabled: false },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ['price'],
          billing_cycle_anchor: 'unchanged',
          proration_behavior: 'always_invoice',
          trial_update_behavior: 'continue_trial',
          schedule_at_period_end: {
            conditions: [{ type: 'decreasing_item_amount' }],
          },
          products: [
            { product: 'prod_flockletter', prices: ['price_starter', 'price_growth', 'price_pro'], adjustable_quantity: { enabled: false } },
          ],
        },
      },
    },
    '/v1/webhook_endpoints': {
      object: 'list',
      has_more: false,
      data: [
        {
          id: 'we_fixture',
          url: 'https://flockletter.example.test/api/v1/customer-billing/stripe-events',
          livemode: false,
          status: 'enabled',
          enabled_events: [...billingProviderEvents],
        },
      ],
    },
  };

  const management = map['/v1/billing_portal/configurations/bpc_fixture'] as {features:{subscription_update:Record<string,unknown>}};
  for(const plan of ['starter','growth','pro'] as const){
    const selected = structuredClone(management) as Record<string,unknown>;
    selected.id = target.planPortalConfigurations[plan];
    selected.metadata = {fl_application:'flockletter',fl_plan:plan};
    const features = selected.features as {subscription_update:Record<string,unknown>};
    features.subscription_update.products = [{product:'prod_flockletter',prices:[target.prices[plan]],adjustable_quantity:{enabled:false}}];
    map['/v1/billing_portal/configurations/'+target.planPortalConfigurations[plan]]=selected;
  }
  management.features.subscription_update = {enabled:false,default_allowed_updates:[],products:[]};

  for (const [id, price] of Object.entries(prices)) {
    map[`/v1/prices/${id}`] = price;
  }

  if (mutate) {
    for (const [path, data] of Object.entries(map)) {
      mutate(path, data as Record<string, unknown>);
    }
  }

  const stripe = new Stripe('sk_test_SYNTHETIC', {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, path: url.pathname, host:url.host,search:url.searchParams });
      if(url.pathname===failPath)return new Response(JSON.stringify({error:{type:'authentication_error',message:'PRIVATE_PROVIDER_DETAIL acct_secret sk_live_SECRET'}}),{status:403,headers:{'content-type':'application/json'}});

      let response = map[url.pathname];
      if(url.pathname==='/v1/webhook_endpoints' && (response as {has_more:boolean}).has_more){
        response=structuredClone(response);
        const page=response as {data:Array<{id:string}>};
        if(page.data[0])page.data[0].id='we_page'+calls.filter(call=>call.path===url.pathname).length;
      }
      if (response === undefined) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      }

      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  });

  return { stripe, calls, target };
}

describe('inspectStripeBillingConfiguration', () => {
  it('verifies a fully correct configuration and issues only GET requests to api.stripe.com', async () => {
    const { stripe, calls } = buildFixture();

    const target = {
      account: 'acct_fixture',
      live: false,
      origin: 'https://flockletter.example.test',
      cardConfiguration: 'pmc_fixture',
      portalConfiguration: 'bpc_fixture',
      planPortalConfigurations: {starter:'bpc_starter',growth:'bpc_growth',pro:'bpc_pro'},
      prices: { starter: 'price_starter', growth: 'price_growth', pro: 'price_pro' },
    };

    const result = await inspectStripeBillingConfiguration(stripe, target);

    expect(result.verified).toBe(true);
    expect(result.live).toBe(false);
    expect(result.checks).toEqual([
      { name: 'account', status: 'pass' },
      { name: 'catalogue', status: 'pass' },
      { name: 'payment_methods', status: 'pass' },
      { name: 'portal', status: 'pass' },
      { name: 'webhook', status: 'pass' },
    ]);

    expect(calls.every((call) => call.method === 'GET' && call.host==='api.stripe.com')).toBe(true);
    expect(calls).toHaveLength(10);
    expect(JSON.stringify(result)).not.toMatch(/acct_|sk_|price_|pmc_|bpc_/);
  });
});

it('stops after an account mismatch before reading foreign resources', async () => {
  const f = buildFixture((path, data) => { if (path === '/v1/account') data.id = 'acct_foreign'; });
  const result = await inspectStripeBillingConfiguration(f.stripe, f.target);
  expect(result).toEqual({ verified: false, live: false, checks: [{ name: 'account', status: 'fail' }] });
  expect(f.calls).toHaveLength(1);
});

const object = (value: unknown) => value as Record<string, unknown>;
it.each([
  ['foreign application product', 'catalogue', (path: string, data: Record<string, unknown>) => {
    if (path === '/v1/prices/price_starter') object(object(data.product).metadata).fl_application = 'another-application';
  }],
  ['foreign application price', 'catalogue', (path: string, data: Record<string, unknown>) => {
    if (path === '/v1/prices/price_starter') object(data.metadata).fl_application = 'another-application';
  }],
  ['wrong price tier mapping', 'catalogue', (path: string, data: Record<string, unknown>) => {
    if (path === '/v1/prices/price_growth') object(data.metadata).fl_plan = 'starter';
  }],
  ['different catalogue product', 'catalogue', (path: string, data: Record<string, unknown>) => {
    if (path === '/v1/prices/price_growth') data.product = {...object(data.product), id: 'prod_foreign'};
  }],
  ['foreign portal product', 'portal', (path: string, data: Record<string, unknown>) => {
    if (path.endsWith('/bpc_starter')) object((object(object(data.features).subscription_update).products as unknown[])[0]).product = 'prod_foreign';
  }],
  ['wrong portal cancellation', 'portal', (path: string, data: Record<string, unknown>) => {
    if (path.includes('/billing_portal/')) object(object(data.features).subscription_cancel).mode = 'immediately';
  }],
  ['upgrade ends trial', 'portal', (path: string, data: Record<string, unknown>) => {
    if (path.includes('/billing_portal/')) object(object(data.features).subscription_update).trial_update_behavior = 'end_trial';
  }],
  ['foreign portal price', 'portal', (path: string, data: Record<string, unknown>) => {
    if (path.endsWith('/bpc_starter')) object((object(object(data.features).subscription_update).products as unknown[])[0]).prices = ['price_foreign'];
  }],
  ['disabled card', 'payment_methods', (path: string, data: Record<string, unknown>) => {
    if (path.includes('/payment_method_configurations/')) object(object(data.card).display_preference).value = 'off';
  }],
  ['wrong payment configuration', 'payment_methods', (path: string, data: Record<string, unknown>) => {
    if (path.includes('/payment_method_configurations/')) data.id = 'pmc_foreign';
  }],
  ['missing webhook', 'webhook', (path: string, data: Record<string, unknown>) => {
    if (path === '/v1/webhook_endpoints') data.data = [];
  }],
  ['duplicate webhook', 'webhook', (path: string, data: Record<string, unknown>) => {
    if (path === '/v1/webhook_endpoints') data.data = [...data.data as unknown[], {...object((data.data as unknown[])[0]), id: 'we_duplicate'}];
  }],
  ['wrong webhook events', 'webhook', (path: string, data: Record<string, unknown>) => {
    if (path === '/v1/webhook_endpoints') object((data.data as unknown[])[0]).enabled_events = ['*'];
  }],
  ['foreign webhook URL', 'webhook', (path: string, data: Record<string, unknown>) => {
    if (path === '/v1/webhook_endpoints') object((data.data as unknown[])[0]).url = 'https://foreign.example.test/api/v1/customer-billing/stripe-events';
  }],
] as const)('refuses %s without declaring billing ready', async (_name, check, mutate) => {
  const f = buildFixture(mutate);
  const result = await inspectStripeBillingConfiguration(f.stripe, f.target);
  expect(result.verified).toBe(false);
  expect(result.checks.find(item => item.name === check)?.status).not.toBe('pass');
  expect(f.calls.every(call => call.method === 'GET' && call.host === 'api.stripe.com')).toBe(true);
});

it('refuses a truncated webhook list after the bounded page limit', async () => {
  const f = buildFixture((path, data) => {
    if (path === '/v1/webhook_endpoints') data.has_more = true;
  });
  const result = await inspectStripeBillingConfiguration(f.stripe, f.target);
  expect(result.verified).toBe(false);
  expect(result.checks.find(item => item.name === 'webhook')?.status).toBe('unavailable');
  expect(f.calls.filter(call => call.path === '/v1/webhook_endpoints')).toHaveLength(5);
  expect(f.calls.filter(call => call.path === '/v1/webhook_endpoints').map(call => call.search.get('limit'))).toEqual(['100','100','100','100','100']);
});

it('redacts failed SDK responses and never logs their provider payload', async () => {
  const f = buildFixture(undefined, '/v1/account');
  const result = await inspectStripeBillingConfiguration(f.stripe, f.target);
  expect(result).toEqual({verified:false,live:false,checks:[{name:'account',status:'unavailable'}]});
  expect(JSON.stringify(result)).not.toMatch(/acct_|sk_|price_|PRIVATE_PROVIDER_DETAIL/);
  expect(f.calls).toHaveLength(1);
});

const environment:NodeJS.ProcessEnv={APP_ENV:'staging',APP_ORIGIN:target.origin,FLOCKLETTER_CUSTOMER_BILLING:'off',
 FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT:target.account,FLOCKLETTER_CUSTOMER_STRIPE_KEY:'rk_test_SYNTHETIC',
 FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG:target.cardConfiguration,FLOCKLETTER_CUSTOMER_STRIPE_PORTAL_CONFIG:target.portalConfiguration,
 FLOCKLETTER_CUSTOMER_STARTER_PORTAL_CONFIG:target.planPortalConfigurations.starter,FLOCKLETTER_CUSTOMER_GROWTH_PORTAL_CONFIG:target.planPortalConfigurations.growth,FLOCKLETTER_CUSTOMER_PRO_PORTAL_CONFIG:target.planPortalConfigurations.pro,
 FLOCKLETTER_CUSTOMER_STARTER_PRICE:target.prices.starter,FLOCKLETTER_CUSTOMER_GROWTH_PRICE:target.prices.growth,FLOCKLETTER_CUSTOMER_PRO_PRICE:target.prices.pro};
it('inspects with customer billing and live approval off, without requiring a webhook signing secret',async()=>{
 const f=buildFixture(),env={...environment,FLOCKLETTER_LIVE_BILLING_APPROVED:'false'};
 const original=JSON.stringify(env);
 const result=await inspectCustomerBillingEnvironment(env,key=>{expect(key).toBe('rk_test_SYNTHETIC');return f.stripe;});
 expect(result.verified).toBe(true);expect(JSON.stringify(env)).toBe(original);
 expect(f.calls.every(call=>call.method==='GET')).toBe(true);
});
it.each(['sk','rk'])('derives live inspection from production for a %s key without enabling billing',async prefix=>{
 const f=buildFixture((path,data)=>{
  if('livemode' in data)data.livemode=true;
  if(path.includes('/prices/'))object(data.product).livemode=true;
  if(path==='/v1/webhook_endpoints')for(const endpoint of data.data as Array<Record<string,unknown>>)endpoint.livemode=true;
 });
 const env={...environment,APP_ENV:'production',FLOCKLETTER_CUSTOMER_STRIPE_KEY:prefix+'_live_SYNTHETIC',FLOCKLETTER_LIVE_BILLING_APPROVED:'false'};
 const result=await inspectCustomerBillingEnvironment(env,()=>f.stripe);
 expect(result).toMatchObject({verified:true,live:true});
 expect(f.calls.every(call=>call.method==='GET')).toBe(true);
});
it.each([
 ['APP_ENV','unknown'],['APP_ORIGIN','http://flockletter.example.test'],['APP_ORIGIN','https://flockletter.example.test/'],
 ['APP_ORIGIN','https://flockletter.example.test/alias'],['APP_ORIGIN','https://flockletter.example.test?alias=1'],
 ['APP_ORIGIN','https://user:password@flockletter.example.test'],['APP_ORIGIN',' https://flockletter.example.test'],
 ['FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT',''],['FLOCKLETTER_CUSTOMER_STRIPE_PORTAL_CONFIG',''],
 ['FLOCKLETTER_CUSTOMER_STARTER_PORTAL_CONFIG',''],['FLOCKLETTER_CUSTOMER_GROWTH_PORTAL_CONFIG','bpc_fixture'],['FLOCKLETTER_CUSTOMER_PRO_PORTAL_CONFIG','bpc_bad/path'],
 ['FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG','pmc_bad/path'],['FLOCKLETTER_CUSTOMER_STRIPE_KEY','sk_live_SYNTHETIC'],
 ['FLOCKLETTER_CUSTOMER_STRIPE_KEY',' sk_test_SYNTHETIC'],['FLOCKLETTER_CUSTOMER_PRO_PRICE','price_growth'],
 ['FLOCKLETTER_CUSTOMER_STARTER_PRICE','price_bad/path'],['FLOCKLETTER_CUSTOMER_BILLING','stripe_live'],
 ['FLOCKLETTER_CUSTOMER_BILLING','unexpected'],
])('refuses invalid %s before constructing any provider client',async(name,value)=>{
 let clients=0;
 const result=await inspectCustomerBillingEnvironment({...environment,[name]:value},()=>{clients++;throw Error('No provider client permitted');});
 expect(clients).toBe(0);expect(result).toMatchObject({verified:false,checks:[{name:'configuration',status:'fail'}]});
 expect(JSON.stringify(result)).not.toContain(value||'PRIVATE_PROVIDER_DETAIL');
});
it('redacts unexpected client construction failures',async()=>{
 const result=await inspectCustomerBillingEnvironment(environment,()=>{throw Error('PRIVATE_PROVIDER_DETAIL sk_live_SECRET');});
 expect(result).toEqual({verified:false,live:false,checks:[{name:'inspection',status:'unavailable'}]});
});
it('the executable refuses incomplete input with structured output and exit one',()=>{
 const result=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../scripts/inspect-customer-billing.ts',import.meta.url))],
  {encoding:'utf8',env:{PATH:process.env.PATH,APP_ENV:'production',APP_ORIGIN:'https://flockletter.example.test'}});
 expect(result.status).toBe(1);expect(result.stderr).toBe('');
 expect(JSON.parse(result.stdout)).toEqual({verified:false,live:true,checks:[{name:'configuration',status:'fail'}]});
});

it('inspects explicit off policy against the same exclusive SaaS catalogue using only reads',async()=>{
 const f=buildFixture((path,data)=>{
  if(path.includes('/prices/')){data.tax_behavior='exclusive';object(data.product).tax_code='txcd_10103001';}
 });
 const result=await inspectCustomerBillingEnvironment({...environment,FLOCKLETTER_BILLING_TAX:'off'},()=>f.stripe);
 expect(result.verified).toBe(true);expect(f.calls.every(call=>call.method==='GET')).toBe(true);
});
it.each(['false','', 'none'])('refuses unsupported tax policy %s before a provider read',async value=>{
 let called=false;const result=await inspectCustomerBillingEnvironment({...environment,FLOCKLETTER_BILLING_TAX:value},()=>{called=true;throw Error('No client permitted');});
 expect(called).toBe(false);expect(result).toMatchObject({verified:false,checks:[{name:'configuration',status:'fail'}]});
});
