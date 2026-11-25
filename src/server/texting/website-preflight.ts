import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { hostedBusinessUrls } from '../../shared/texting-policy-pages.js';
import { enrollmentPageReader } from './public-page-reader.js';

export type EnrollmentPages = { website: string; privacyPolicyUrl: string; smsTermsUrl: string; signupUrl: string; hostedPages?: boolean };
export type PageIssue = { page: 'website' | 'privacy' | 'terms' | 'signup'; message: string };
export type EnrollmentPageReader = (url: string) => Promise<string>;

const names = { website: 'business website', privacy: 'privacy policy', terms: 'SMS terms', signup: 'hosted SMS opt-in preview' };
// Four bounded requests per scan. Reject excess work instead of queuing network and memory indefinitely.
const activeDomains = new Map<string, number>();
let activeScans = 0;
const rates = /(?:message|messaging|msg)(?:s|\.)?\s*(?:and|&)\s*data rates/i;
const frequency = /\b(frequency|(?:messages?|msgs?|texts?)\s*(?:per|a|each|\/)\s*(?:day|month|week))\b/i;

function visiblePage(html: string, url: string) {
  const stack: DefaultTreeAdapterTypes.Node[] = [parse(html)];
  const words: string[] = [], links = new Set<string>();
  let optionalConsent = false;
  while (stack.length) {
    const node = stack.pop()!;
    if ('tagName' in node) {
      const attrs = new Map(node.attrs.map(a => [a.name, a.value]));
      if (['head','script','style','template','noscript','svg'].includes(node.tagName) || attrs.has('hidden') ||
          attrs.get('aria-hidden') === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.get('style') ?? '')) continue;
      if (node.tagName === 'input' && attrs.get('name') === 'smsConsent' && attrs.get('type') === 'checkbox' &&
          !attrs.has('required') && !attrs.has('checked')) optionalConsent = true;
      if (node.tagName === 'a' && attrs.has('href')) {
        try { links.add(new URL(attrs.get('href')!, url).href); } catch { /* Ignore malformed unrelated links. */ }
      }
    }
    if ('value' in node && node.nodeName === '#text') words.push(node.value);
    if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
  }
  return { words: words.join(' ').replace(/\s+/g, ' ').trim(), links, optionalConsent };
}

function disclosures(page: PageIssue['page'], html: string, url: string, input: EnrollmentPages): string[] {
  const { words, links, optionalConsent } = visiblePage(html, url);
  if (!words) return ['Publish a readable ' + names[page] + ' page.'];
  if (page === 'website') return [];
  if (page === 'privacy') {
    const sms = /\b(mobile|sms|text(?:ing)?|opt[ -]?in)\b/i.test(words);
    const noSharing = /\b(?:no\b[^.!?]{0,100}|(?:not|never|don['’]t|won['’]t)\b[^.!?]{0,65})(?:shar(?:e|ed|ing)|sell|sold)\b[^.!?]{0,150}\b(?:marketing|promotional)\b/i.test(words);
    return sms && noSharing ? [] : ['Explain how you use mobile opt-in data and that you do not share it with third parties for marketing.'];
  }
  const issues: string[] = [];
  if (!rates.test(words) || !frequency.test(words)) issues.push('Disclose message frequency and that message and data rates may apply.');
  if (!/\bSTOP\b/i.test(words) || !/\bHELP\b/i.test(words)) issues.push('Explain how to reply STOP to opt out and HELP for assistance.');
  if (page === 'signup') {
    if (!optionalConsent) issues.push('Enable the optional, unchecked SMS consent box on the company signup form.');
    if (!links.has(input.privacyPolicyUrl) || !links.has(input.smsTermsUrl)) issues.push('Link the signup form to the privacy policy and SMS terms accepted for this company.');
  }
  return issues;
}

/** Fetch only the three public documents and the saved company's exact signup preview. Results contain no fetched text. */
export async function scanEnrollmentPages(input: EnrollmentPages, readPage?: EnrollmentPageReader): Promise<{ issues: PageIssue[] }> {
  const known = hostedBusinessUrls(input.signupUrl);
  const signup = new URL(input.signupUrl);
  signup.searchParams.set('preview','sms');
  const ownPages = new Set([signup.href]);
  if (input.hostedPages) {
    if (input.website !== known.website || input.privacyPolicyUrl !== known.privacyPolicyUrl || input.smsTermsUrl !== known.smsTermsUrl)
      return { issues: [{ page: 'website', message: 'Use the hosted pages published for this company.' }] };
    for (const url of Object.values(known)) ownPages.add(url);
  }
  const read = readPage ?? enrollmentPageReader(signup.origin, ownPages);
  const urls = { website: input.website, privacy: input.privacyPolicyUrl, terms: input.smsTermsUrl, signup: signup.href };
  const domain = new URL(input.website).hostname.toLowerCase().replace(/^www\./, '');
  if (activeScans >= 3 || (activeDomains.get(domain) ?? 0) >= 2)
    return { issues: [{ page: 'website', message: 'Website checks are busy. Check the pages again shortly.' }] };
  activeScans++;
  activeDomains.set(domain, (activeDomains.get(domain) ?? 0) + 1);
  try {
    const issues = await Promise.all((Object.keys(urls) as PageIssue['page'][]).map(async page => {
      const url = urls[page];
      try {
        const html = await read(url);
        return disclosures(page, html, url, input).map(message => ({ page, message }));
      } catch {
        return [{ page, message: 'Could not read the ' + names[page] + '. Check that it opens publicly as an HTML page and retry.' }];
      }
    }));
    return { issues: issues.flat() };
  } finally {
    activeScans--;
    const remaining = activeDomains.get(domain)! - 1;
    if (remaining) activeDomains.set(domain, remaining);
    else activeDomains.delete(domain);
  }
}
