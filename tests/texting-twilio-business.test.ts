// Twilio refuses a business profile unless business_type, business_industry and company_type use its exact
// strings. These tests pin what the live adapter sends (no network: fetch is faked).
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { twilioBusiness, twilioBusinessTypes, twilioIndustries } from '../src/shared/texting-business.js';
import { TwilioHttpPlatform } from '../src/server/texting/twilio-http.js';
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
    const result = await platform.createCustomerProfile(account, 'sms-reg/test/1/customer_profile', profile, 'https://example.com/callback');
    expect(result.outcome).toBe('accepted');
    const attributes = (type: string) => JSON.parse(posts.find(p => p.form.get('Type') === type)!.form.get('Attributes')!) as Record<string, string>;
    expect(attributes('customer_profile_business_information')).toMatchObject({ business_type: 'Limited Liability Corporation', business_industry: 'HOSPITALITY' });
    expect(attributes('us_a2p_messaging_profile_information')).toEqual({ company_type: 'private' });
    expect(posts.some(p => p.form.toString().includes('private_profit'))).toBe(false);
  });
});
