// Twilio refuses a business profile unless business_type, business_industry and company_type use its exact
// strings. These tests pin what the live adapter sends (no network: fetch is faked).
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { twilioBusiness, twilioBusinessTypes, twilioIndustries } from '../src/shared/texting-business.js';
import { TwilioHttpPlatform, twilioName } from '../src/server/texting/twilio-http.js';
import type { AccountCredentials, BusinessProfile } from '../src/server/texting/twilio.js';

describe('Twilio business rules', () => {
  it('maps each supported entity type to Twilio’s company type', () => {
    expect(twilioBusiness('private_profit', 'Limited Liability Corporation', 'HOSPITALITY')).toEqual({ companyType: 'private' });
    expect(twilioBusiness('private_profit', 'Partnership', 'REAL_ESTATE')).toEqual({ companyType: 'private' });
    expect(twilioBusiness('non_profit', 'Non-profit Corporation', 'NOT_FOR_PROFIT')).toEqual({ companyType: 'non-profit' });
    expect(twilioBusiness('government', 'Non-profit Corporation', 'GOVERNMENT')).toEqual({ companyType: 'government' });
  });
  it('refuses combinations Twilio would refuse', () => {
    expect(twilioBusiness('private_profit', 'private_profit', 'HOSPITALITY')).toEqual({ reason: 'business_type_invalid' });
    expect(twilioBusiness('private_profit', 'Limited Liability Corporation', 'Hospitality')).toEqual({ reason: 'industry_invalid' });
    expect(twilioBusiness('private_profit', 'Non-profit Corporation', 'HOSPITALITY')).toEqual({ reason: 'business_type_mismatch' });
    expect(twilioBusiness('non_profit', 'Corporation', 'NOT_FOR_PROFIT')).toEqual({ reason: 'business_type_mismatch' });
    expect(twilioBusiness('non_profit', 'Non-profit Corporation', 'EDUCATION')).toEqual({ reason: 'industry_mismatch' });
    expect(twilioBusiness('government', 'Non-profit Corporation', 'NOT_FOR_PROFIT')).toEqual({ reason: 'industry_mismatch' });
    expect(twilioBusiness('public_profit', 'Corporation', 'TECHNOLOGY')).toEqual({ reason: 'public_company_unsupported' });
    expect(twilioBusiness('sole_proprietor', 'Partnership', 'RETAIL')).toEqual({ reason: 'sole_proprietor_unsupported' });
  });
  it('keeps Twilio’s documented lists', () => {
    expect(twilioBusinessTypes).toHaveLength(5);
    expect(twilioIndustries).toContain('HOSPITALITY');
    expect(twilioIndustries).toHaveLength(33);
  });
});

describe('live adapter business profile', () => {
  it('sends Twilio’s business type, industry and company type, not the internal entity type', async () => {
    const posts: { url: string; form: URLSearchParams }[] = [];
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (method === 'GET') return json(200, url.includes('/Addresses.json') ? { addresses: [], next_page_uri: null } : { results: [], meta: { next_page_url: null } });
      const form = new URLSearchParams(String(init?.body ?? ''));
      posts.push({ url, form });
      if (url.endsWith('/EntityAssignments')) return json(201, { sid: 'BV' + randomBytes(16).toString('hex') });
      if (form.get('Status') === 'pending-review') return json(200, { sid: 'BU' + randomBytes(16).toString('hex'), status: 'pending-review' });
      return json(201, { sid: 'XX' + randomBytes(16).toString('hex'), friendly_name: form.get('FriendlyName'), status: 'draft' });
    }) as typeof fetch;
    const platform = new TwilioHttpPlatform({ user: 'SK' + '0'.repeat(32), secret: 'synthetic', accountSid: 'AC' + '0'.repeat(32) },
      { secondaryProfile: 'RN' + '1'.repeat(32), a2pProfile: 'RN' + '2'.repeat(32), primaryProfileSid: 'BU' + '3'.repeat(32) }, fakeFetch);
    const account: AccountCredentials = { accountSid: 'AC' + '4'.repeat(32), keySid: 'SK' + '5'.repeat(32), keySecret: 'synthetic', authToken: 'synthetic' };
    const profile: BusinessProfile = {
      legalName: 'Synthetic Hospitality, LLC', dbaName: null, entityType: 'private_profit', businessType: 'Limited Liability Corporation', companyType: 'private',
      ein: '12-3456789', website: 'https://example.com', vertical: 'HOSPITALITY',
      address: { street: '1 Main St', city: 'Keystone', region: 'CO', postalCode: '80435', country: 'US' },
      contact: { firstName: 'Pat', lastName: 'Owner', email: 'pat@example.com', phone: '+19705550100', title: 'Owner' }, notificationEmail: 'pat@example.com',
    };
    const op = 'sms-reg/b01f8848-5818-4d53-b554-1e89fd55dc58/10/customer_profile';
    const result = await platform.createCustomerProfile(account, op, profile, 'https://example.com/callback');
    expect(result.outcome).toBe('accepted');
    const attributes = (type: string) => JSON.parse(posts.find(p => p.form.get('Type') === type)!.form.get('Attributes')!) as Record<string, string>;
    expect(attributes('customer_profile_business_information')).toMatchObject({ business_type: 'Limited Liability Corporation', business_industry: 'HOSPITALITY' });
    expect(attributes('us_a2p_messaging_profile_information')).toEqual({ company_type: 'private' });
    expect(posts.some(p => p.form.toString().includes('private_profit'))).toBe(false);
    // Twilio refuses an Address FriendlyName over 64 characters with error 20400 (first live submit, 2026-11-19).
    const names = posts.map(p => p.form.get('FriendlyName')).filter((n): n is string => n !== null);
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
    expect(names).toContain(twilioName(op + '/address'));
  });
  it('files the campaign with its use case, Low Volume Mixed or Marketing', async () => {
    const posts: URLSearchParams[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ compliance: [], meta: { next_page_url: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
      posts.push(new URLSearchParams(String(init?.body ?? '')));
      return new Response(JSON.stringify({ sid: 'QE' + randomBytes(16).toString('hex'), campaign_status: 'IN_PROGRESS' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const platform = new TwilioHttpPlatform({ user: 'SK' + '0'.repeat(32), secret: 'synthetic', accountSid: 'AC' + '0'.repeat(32) },
      { secondaryProfile: 'RN' + '1'.repeat(32), a2pProfile: 'RN' + '2'.repeat(32), primaryProfileSid: 'BU' + '3'.repeat(32) }, fakeFetch);
    const account: AccountCredentials = { accountSid: 'AC' + '4'.repeat(32), keySid: 'SK' + '5'.repeat(32), keySecret: 'synthetic', authToken: 'synthetic' };
    const input = { description: 'Synthetic texts about open dates and booked stays.', messageFlow: 'Sign-up page checkbox.', samples: ['Sample one text here.', 'Sample two text here.'],
      optInMessage: 'Reply YES', optOutMessage: 'Unsubscribed', helpMessage: 'Help', hasLinks: true };
    for (const useCase of ['LOW_VOLUME', 'MARKETING'] as const) {
      const result = await platform.submitCampaign(account, `sms-reg/x/1/campaign-${useCase}`, 'MG' + '6'.repeat(32), 'BN' + '7'.repeat(32), { ...input, useCase, privacyPolicyUrl: 'https://example.com/privacy', termsUrl: 'https://example.com/sms-terms' });
      expect(result.outcome).toBe('accepted');
    }
    expect(posts.map(p => p.get('UsAppToPersonUsecase'))).toEqual(['LOW_VOLUME', 'MARKETING']);
    // Twilio rejects a campaign without these as separate fields (30908, 30882; FF Hospitality, 2026-11-21).
    expect(posts.map(p => [p.get('PrivacyPolicyUrl'), p.get('TermsAndConditionsUrl')])).toEqual([['https://example.com/privacy', 'https://example.com/sms-terms'], ['https://example.com/privacy', 'https://example.com/sms-terms']]);
  });
  it('reads an approved brand whose errors field is null, as Twilio sends it', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ sid: 'BN' + '8'.repeat(32), status: 'APPROVED', identity_status: 'VETTED_VERIFIED', failure_reason: null, errors: null }),
      { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const platform = new TwilioHttpPlatform({ user: 'SK' + '0'.repeat(32), secret: 'synthetic', accountSid: 'AC' + '0'.repeat(32) },
      { secondaryProfile: 'RN' + '1'.repeat(32), a2pProfile: 'RN' + '2'.repeat(32), primaryProfileSid: 'BU' + '3'.repeat(32) }, fakeFetch);
    const account: AccountCredentials = { accountSid: 'AC' + '4'.repeat(32), keySid: 'SK' + '5'.repeat(32), keySecret: 'synthetic', authToken: 'synthetic' };
    await expect(platform.status('brand', account, 'BN' + '8'.repeat(32))).resolves.toEqual({ outcome: 'accepted', value: { status: 'APPROVED' } });
  });
  it('reads structured brand and campaign rejection codes without retaining the provider’s private descriptions', async () => {
    const key = 'AC' + 'a'.repeat(32);
    const response = {status:'FAILED', campaign_status:'FAILED', failure_reason:'private application data',
      errors:[{error_code:30795, error_description:'private business details'},{error_code:'30908'}, {error_code:30795}]};
    const platform = new TwilioHttpPlatform({ user:'SK'+'a'.repeat(32),secret:'fixture',accountSid:key },
      {secondaryProfile:'RN'+'1'.repeat(32),a2pProfile:'RN'+'2'.repeat(32),primaryProfileSid:'BU'+'3'.repeat(32)},
      async () => new Response(JSON.stringify(response),{status:200}));
    const account:AccountCredentials = {accountSid:key,keySid:'SK'+'a'.repeat(32),keySecret:'fixture',authToken:'fixture'};
    for (const kind of ['brand','campaign'] as const) {
      expect(await platform.status(kind,account,'fixture','service')).toEqual({outcome:'accepted',value:{status:'FAILED',reason:'30795,30908'}});
    }
  });
  it('keeps short names and shortens long ones the same way every time', () => {
    expect(twilioName('sms-reg/abc/1/number')).toBe('sms-reg/abc/1/number');
    const long = 'sms-reg/b01f8848-5818-4d53-b554-1e89fd55dc58/1/customer_profile/address';
    expect(twilioName(long)).toBe(twilioName(long));
    expect(twilioName(long)).toMatch(/^fl\/[0-9a-f]{32}\/address$/);
    expect(twilioName(long)).not.toBe(twilioName(long.replace('/1/', '/2/')));
    expect(twilioName('sms-reg/b01f8848-5818-4d53-b554-1e89fd55dc58/10/messaging_service').length).toBeLessThanOrEqual(64);
  });
});
