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
export function SignupFields({
  consent,
  version,
  preview = false,
}: {
  consent: string;
  version: string;
  preview?: boolean;
}) {
  return (
    <form
      method="post"
      onSubmit={preview ? (e) => e.preventDefault() : undefined}
    >
      <label>
        Email address
        <input
          required
          type="email"
          autoComplete="email"
          name="email"
          maxLength={254}
        />
      </label>
      <input type="hidden" name="policyVersion" value={version} />
      <label className="postcard-consent">
        <input required type="checkbox" name="consentAffirmed" value="yes" />
        {consent}
      </label>
      <button type={preview ? "button" : "submit"} disabled={preview}>
        Subscribe
      </button>
    </form>
  );
}
