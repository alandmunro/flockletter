import { COOKIE_PREFERENCE_KEY, COOKIE_NOTICE_VERSION } from '../shared/cookie-consent.js';
import { supportAddress } from '../shared/support.js';
import { PRIVACY_NOTICE_UPDATED, PRIVACY_NOTICE_VERSION } from '../shared/privacy-notice.js';

export function Privacy() {
  return <main id="main" className="main privacy-page">
    <section className="card">
      <span className="eyebrow">Flockletter · Frosty Flamingo Software, LLC</span>
      <h1 className="page-heading">Privacy &amp; cookies</h1>
      <p>Privacy notice: {PRIVACY_NOTICE_VERSION}. Updated {PRIVACY_NOTICE_UPDATED}.</p>
      <p>Cookie notice: {COOKIE_NOTICE_VERSION}. Updated November 8, 2026.</p>
      <h2>Necessary cookies and browser storage</h2>
      <p>Flockletter uses Clerk for secure sign-in and workspace membership. Sign-in cookies and security-related storage help keep your account accessible and protected. Rejecting optional cookies does not turn off these necessary functions.</p>
      <p>Your cookie choice applies for up to 180 days and is saved in this browser under <code>{COOKIE_PREFERENCE_KEY}</code>. It contains the notice version, choice, time and listed optional purposes, without an account identifier. Refreshing does not extend that time. On your next visit after expiry, the old preference is removed and we ask again. Choices apply to this site and browser; they are separate from other Frosty Flamingo websites and devices.</p>
      <h2>Optional website cookies</h2>
      <p>Flockletter currently uses no optional website analytics or advertising cookies. Accept all cookies covers only the uses listed in this notice. It does not permit future tracking providers or new purposes; those require an updated notice and a fresh choice. Optional tracking stays off when a browser privacy signal is present.</p>
      <h2>Change your choice</h2>
      <p>Use Cookie choices on any page to accept or reject optional cookies, including withdrawing a previous acceptance. Rejecting does not sign you out, remove your workspace, interrupt a saved campaign or change your plan.</p>
      <button type="button" className="button secondary" onClick={()=>window.dispatchEvent(new CustomEvent('flockletter:cookie-choices'))}>Manage cookie choices</button>
      <h2>Email subscriptions and account data</h2>
      <p>Cookie choices do not subscribe you to marketing email, establish subscriber consent or change newsletter tracking preferences. Newsletter subscriptions have their own consent and unsubscribe controls. Brands may require email confirmation or accept signup immediately. An authorized owner may record existing permission without email verification; that does not prove ownership of an email address. Workspace owners can review account data and retention options in Data &amp; privacy.</p>
      <p>Flockletter processes sign-in, workspace, campaign and support information to provide the service. For questions about your information or a privacy request, contact <a href={'mailto:'+supportAddress}>{supportAddress}</a>. Requests involving account information require verification of your authority.</p>
      <h2>Account retention</h2>
      <p>Ordinary account data is retained for 90 days after verified service end, then purged through protected erasure checks. Reinstatement or an authorized review hold can block erasure.</p>
      <h2 id="trial-eligibility">Lifetime trial eligibility</h2>
      <p>To prevent repeat free trials, we retain minimal keyed codes for the trial owner, card and workspace indefinitely, including after ordinary account erasure. These codes and the necessary policy, status and timing metadata are used solely to enforce lifetime one-trial eligibility and prevent eligibility from being refreshed.</p>
      <p>These records are pseudonymous personal data, not anonymous data. This retained trial history excludes raw sign-in and workspace identifiers, provider card fingerprints, email addresses, card numbers, physical addresses, messages and mailing-list content.</p>
      <p><a href="/">Return to Flockletter</a> · <a href="/help">Email support</a></p>
    </section>
  </main>;
}
