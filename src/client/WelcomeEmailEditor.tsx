import { useEffect, useState } from "react";
import { imageDataUrl } from "./api.js";
import type { AudienceSettingsView } from "../shared/customer-audience.js";
import type { SignupDesign, WelcomeDesign } from "../shared/signup-design.js";
import { renderWelcomePreview } from "../shared/welcome-email.js";

type Props = {
  view: AudienceSettingsView;
  design: SignupDesign;
  edit: (patch: Partial<WelcomeDesign>) => void;
  save: () => Promise<void>;
  busy: boolean;
  error: string;
  notice: string;
  logoUrl: string;
  logo?: { width: number; height: number };
};

export function WelcomeEmailEditor({ view, design, edit, save, busy, error, notice, logoUrl, logo }: Props) {
  const [open, setOpen] = useState(false);
  const [postage, setPostage] = useState("");
  useEffect(() => {
    if (!open || design.logoId || postage) return;
    const controller = new AbortController();
    fetch("/brand/newsletter-postage.png", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await imageDataUrl(await response.blob());
        if (!controller.signal.aborted) setPostage(data);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [open, design.logoId, postage]);
  const welcome = design.welcome ?? { enabled: false };
  const brandName = design.displayName || view.brandName;
  let preview: ReturnType<typeof renderWelcomePreview> | null = null;
  let previewError = "";
  if (open) {
    try {
      preview = renderWelcomePreview(design, view.brandName, {
        postage,
        logo: logo && logoUrl ? { url: logoUrl, ...logo } : undefined,
      });
    } catch {
      previewError = "Use a full https:// link for the button.";
    }
  }
  const frameKey = JSON.stringify([brandName, design.font, design.accent, design.logoId, welcome, Boolean(logoUrl), Boolean(postage)]);
  return (
    <details className="design-studio" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Design studio · Welcome email</summary>
      <div className="studio-columns">
        <div>
          <p className="help">
            Sent once, right after a new subscriber confirms their email. Use it to thank them and share a promo code.
            The code is shown as written; Flockletter doesn’t create or track it, so set it up where customers redeem it.
          </p>
          {view.confirmationMode === "single_opt_in" && <p className="notice">Welcome emails go only to subscribers who confirm by email. Turn on email confirmation in signup settings to use it.</p>}
          <fieldset disabled={busy}>
            <label className="checkbox">
              <input type="checkbox" checked={welcome.enabled} onChange={(e) => edit({ enabled: e.target.checked })} />
              Send a welcome email after confirmation
            </label>
            <label>Email subject
              <input maxLength={120} value={welcome.subject ?? ""} placeholder={`Welcome to the ${brandName} newsletter`} onChange={(e) => edit({ subject: e.target.value })} />
            </label>
            <label>Heading
              <input maxLength={120} value={welcome.heading ?? ""} placeholder="You’re subscribed" onChange={(e) => edit({ heading: e.target.value })} />
            </label>
            <label>Message
              <textarea maxLength={800} rows={4} value={welcome.message ?? ""} placeholder={`Thank you for signing up for the ${brandName} newsletter.`} onChange={(e) => edit({ message: e.target.value })} />
            </label>
            <label>Promo code
              <input maxLength={40} value={welcome.promoCode ?? ""} placeholder="e.g. Dec2026" onChange={(e) => edit({ promoCode: e.target.value })} />
            </label>
            <label>Promo details
              <input maxLength={200} value={welcome.promoDetails ?? ""} placeholder="e.g. Use it when you book direct. Expires December 31, 2026." onChange={(e) => edit({ promoDetails: e.target.value })} />
            </label>
            <label>Button link
              <input type="url" maxLength={500} value={welcome.link ?? ""} placeholder="https://" onChange={(e) => edit({ link: e.target.value })} />
            </label>
            <label>Button label
              <input maxLength={60} value={welcome.button ?? ""} placeholder={`Visit ${brandName}`} onChange={(e) => edit({ button: e.target.value })} />
            </label>
            <button className="btn" type="button" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save welcome email"}
            </button>
          </fieldset>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </div>
        <div>
          <p>Preview{welcome.enabled ? "" : " · off"}</p>
          {previewError && <p role="alert">{previewError}</p>}
          {preview && <>
            <p><strong>Subject</strong> · {preview.subject}</p>
            <iframe key={frameKey} sandbox="" title="Welcome email preview" srcDoc={preview.html} className="customer-capture-preview" />
          </>}
        </div>
      </div>
    </details>
  );
}
