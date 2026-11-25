import type { ReactNode } from "react";
import type { SignupDesign } from "./signup-design.js";

export function SignupPostcard({
  design,
  brandName,
  logo,
  title,
  footer,
  children,
}: {
  design: SignupDesign;
  brandName: string;
  logo?: string;
  title: string;
  footer: string;
  children: ReactNode;
}) {
  return (
    <div className="signup-postcard" data-font={design.font}>
      <article className="postcard-sheet">
        <header className="postcard-head">
          <div>
            <div className="postcard-name">
              {design.displayName || brandName}
            </div>
            <div className="postcard-kicker">Newsletter</div>
          </div>
          <img
            className="postcard-mark"
            src={logo || "/brand/newsletter-postage.png"}
            alt=""
          />
        </header>
        <section className="postcard-body">
          <h1>{title}</h1>
          {children}
        </section>
        <footer className="postcard-foot">{footer}</footer>
      </article>
    </div>
  );
}
export type SignupTexting = { phone: boolean; birthday: boolean; anniversary: boolean; anniversaryLabel: string; smsWording: string | null; smsTermsUrl?: string | null; privacyPolicyUrl?: string | null;
  /** Registration under way: the SMS box is shown greyed out with its disclosures and cannot be ticked. */
  smsPending?: boolean;
  /** Optional first and last name fields (D3). */
  name?: boolean;
  /** Email is optional: a sign-up needs an email or a phone with the text box ticked (D1). */
  phoneOnly?: boolean };
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function MonthDay({ prefix, label, year = false }: { prefix: string; label: string; year?: boolean }) {
  return (
    <fieldset className="postcard-date">
      <legend>{label} (optional)</legend>
      <select name={prefix + "Month"} defaultValue="" aria-label={label + " month"}>
        <option value="">Month</option>
        {months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
      </select>
      <select name={prefix + "Day"} defaultValue="" aria-label={label + " day"}>
        <option value="">Day</option>
        {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
      </select>
      {year && <input name={prefix + "Year"} inputMode="numeric" pattern="[0-9]{4}" maxLength={4} placeholder="Year" aria-label={label + " year"} />}
    </fieldset>
  );
}
/** FL-SMS-007: optional phone, birthday and anniversary fields; the SMS checkbox is separate, optional and unchecked. */
function TextingFields({ texting }: { texting: SignupTexting }) {
  return (
    <>
      {texting.phone && (
        <label>
          {texting.phoneOnly ? "Mobile number (US only)" : "Mobile number (optional, US only)"}
          <input type="tel" name="phone" autoComplete="tel" maxLength={20} />
        </label>
      )}
      {texting.phone && texting.smsWording && (
        <label className="postcard-consent">
          <input type="checkbox" name="smsConsent" value="yes" disabled={texting.smsPending} />
          {texting.smsWording}
          {!texting.smsPending && <input type="hidden" name="smsWording" value={texting.smsWording} />}
        </label>
      )}
      {texting.phone && texting.smsWording && texting.smsPending && (
        <p className="postcard-consent-links">Text messages start soon. This box can be ticked once texting is live.</p>
      )}
      {texting.phone && texting.smsWording && (texting.smsTermsUrl || texting.privacyPolicyUrl) && (
        <p className="postcard-consent-links">
          {texting.smsTermsUrl && <a href={texting.smsTermsUrl} target="_blank" rel="noopener noreferrer">SMS terms</a>}
          {texting.smsTermsUrl && texting.privacyPolicyUrl && ' | '}
          {texting.privacyPolicyUrl && <a href={texting.privacyPolicyUrl} target="_blank" rel="noopener noreferrer">Privacy policy</a>}
        </p>
      )}
      {texting.birthday && <MonthDay prefix="birthday" label="Birthday" />}
      {texting.anniversary && <MonthDay prefix="anniversary" label={texting.anniversaryLabel} year />}
    </>
  );
}
export function SignupFields({
  consent,
  version,
  preview = false,
  texting,
  action,
}: {
  consent: string;
  version: string;
  preview?: boolean;
  texting?: SignupTexting;
  action?: string;
}) {
  const emailOptional = texting?.phoneOnly === true;
  return (
    <form
      method="post"
      action={action}
      onSubmit={preview ? (e) => e.preventDefault() : undefined}
    >
      {texting?.name && (
        <div className="postcard-names">
          <label>
            First name (optional)
            <input type="text" name="firstName" autoComplete="given-name" maxLength={60} />
          </label>
          <label>
            Last name (optional)
            <input type="text" name="lastName" autoComplete="family-name" maxLength={60} />
          </label>
        </div>
      )}
      {emailOptional && (
        <p>Sign up with your email, your mobile number, or both.</p>
      )}
      <label>
        {emailOptional ? "Email address (optional if you sign up for texts)" : "Email address"}
        <input
          required={!emailOptional}
          type="email"
          autoComplete="email"
          name="email"
          maxLength={254}
        />
      </label>
      <input type="hidden" name="policyVersion" value={version} />
      <label className="postcard-consent">
        <input required={!emailOptional} type="checkbox" name="consentAffirmed" value="yes" />
        {consent}
      </label>
      {texting && <TextingFields texting={texting} />}
      <button type={preview ? "button" : "submit"} disabled={preview}>
        Subscribe
      </button>
    </form>
  );
}
