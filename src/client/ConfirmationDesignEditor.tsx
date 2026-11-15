import { useEffect, useId, useState, type CSSProperties } from "react";
import { imageDataUrl, type Api } from "./api.js";
import { BrandImageUpload } from "./BrandImageUpload.js";
import type { useBrandImages } from "./useBrandImages.js";
import type { AudienceSettingsView } from "../shared/customer-audience.js";
import { buttonInk, type SignupDesign } from "../shared/signup-design.js";
import { renderConfirmationPreview } from "../shared/confirmation-email.js";
import { SignupPostcard } from "../shared/SignupPostcard.js";
import { ConfirmationFormContent } from "../shared/ConfirmationFormContent.js";

type Props = {
  api: Api;
  view: AudienceSettingsView;
  design: SignupDesign;
  edit: (patch: NonNullable<SignupDesign["confirmation"]>) => void;
  save: () => Promise<void>;
  busy: boolean;
  error: string;
  notice: string;
  library: ReturnType<typeof useBrandImages>;
  logoUrl: string;
  photoUrl: string;
};

export function ConfirmationDesignEditor({
  api, view, design, edit, save, busy, error, notice, library, logoUrl, photoUrl,
}: Props) {
  const [preview, setPreview] = useState("email");
  const [open, setOpen] = useState(false);
  const [postage, setPostage] = useState("");
  const [postageError, setPostageError] = useState("");
  const previewId = useId();
  useEffect(() => {
    if (!open || design.logoId || postage) return;
    const controller = new AbortController();
    setPostageError("");
    fetch("/brand/newsletter-postage.png", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await imageDataUrl(await response.blob());
        if (!controller.signal.aborted) setPostage(data);
      })
      .catch(() => { if (!controller.signal.aborted) setPostageError("The postage image could not be previewed."); });
    return () => controller.abort();
  }, [open, design.logoId, postage]);
  const confirmation = design.confirmation ?? {};
  const brandName = design.displayName || view.brandName;
  const logo = library.assets.find((asset) => asset.id === design.logoId);
  const photo = library.assets.find((asset) => asset.id === confirmation.photoId);
  // A sandboxed srcDoc frame has an opaque origin. Remount it when the draft
  // changes so the app's frame-src policy permits the fresh preview navigation.
  const frameKey = JSON.stringify([brandName, design.font, design.accent, design.logoId,
    confirmation, Boolean(logoUrl && logo), Boolean(photoUrl && photo), Boolean(postage)]);
  const email = open && preview === "email" ? renderConfirmationPreview(design, view.brandName, {
    postage,
    logo: logo && logoUrl ? { url: logoUrl, width: logo.width, height: logo.height } : undefined,
    photo: photo && photoUrl ? { url: photoUrl, width: photo.width, height: photo.height } : undefined,
  }) : null;
  return (
    <details className="design-studio" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Design studio · Confirmation email and form</summary>
      <div className="studio-columns">
        <div>
          <p className="help">The email invites a subscriber to open the confirmation form. Both use the logo, color and typeface from Brand identity.</p>
          {view.confirmationMode === "single_opt_in" && <p className="notice">New signups currently subscribe immediately. Enable email confirmation in signup settings to use this design for them.</p>}
          <fieldset disabled={busy}>
            <label>Email subject
              <input maxLength={120} value={confirmation.subject ?? ""} placeholder={`Confirm your ${brandName} subscription`} onChange={(e) => edit({ subject: e.target.value })} />
            </label>
            <label>Confirmation heading
              <input maxLength={120} value={confirmation.heading ?? ""} placeholder="Confirm your email" onChange={(e) => edit({ heading: e.target.value })} />
            </label>
            <label>Welcome message
              <textarea maxLength={800} rows={4} value={confirmation.message ?? ""} placeholder={`Thanks for signing up for the ${brandName} newsletter.`} onChange={(e) => edit({ message: e.target.value })} />
            </label>
            <label>Confirmation button label
              <input maxLength={60} value={confirmation.button ?? ""} placeholder="Confirm my subscription" onChange={(e) => edit({ button: e.target.value })} />
            </label>
            <label>Featured image
              <select value={confirmation.photoId ?? ""} onChange={(e) => edit({ photoId: e.target.value || null })}>
                <option value="">No featured image</option>
                {library.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select>
            </label>
            <BrandImageUpload api={api} brandId={view.brandId} onUploaded={library.accept} />
            <button className="btn" type="button" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save confirmation design"}
            </button>
          </fieldset>
          {(error || (!design.logoId && postageError)) && <p role="alert">{error || postageError}</p>}
          {notice && <p role="status">{notice}</p>}
        </div>
        <div style={{ "--postcard-accent": design.accent, "--postcard-ink": buttonInk(design.accent) } as CSSProperties}>
          <label htmlFor={previewId}>Preview</label>
            <select id={previewId} value={preview} onChange={(e) => setPreview(e.target.value)}>
              <option value="email">Confirmation email</option>
              <option value="form">Confirmation form</option>
            </select>
          {email && <>
            <p><strong>Subject</strong> · {email.subject}</p>
            <iframe key={frameKey} sandbox="" title="Confirmation email preview" srcDoc={email.html} className="customer-capture-preview" />
          </>}
          {preview === "form" && <SignupPostcard
            design={design} brandName={view.brandName} logo={logoUrl}
            title={confirmation.heading || "Confirm your subscription"}
            footer="You can unsubscribe from any newsletter."
          >
            <ConfirmationFormContent design={design} brandName={view.brandName} photoUrl={photoUrl} />
          </SignupPostcard>}
        </div>
      </div>
    </details>
  );
}
