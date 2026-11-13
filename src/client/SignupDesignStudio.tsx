import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AudienceSettingsView } from "../shared/customer-audience.js";
import {
  buttonInk,
  defaultDesign,
  type SignupDesign,
} from "../shared/signup-design.js";
import { SignupFields, SignupPostcard } from "../shared/SignupPostcard.js";
import { operationKey, type Api } from "./api.js";
import { BrandImageUpload } from "./BrandImageUpload.js";
import { useBrandImages } from "./useBrandImages.js";

export function SignupDesignStudio({
  api,
  view,
}: {
  api: Api;
  view: AudienceSettingsView;
}) {
  const [design, setDesign] = useState(view.design ?? defaultDesign);
  const [revision, setRevision] = useState(view.designRevision ?? 0);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [logo, setLogo] = useState(""),
    key = useRef(operationKey());
  const library = useBrandImages(api, view.brandId);
  useEffect(() => {
    let active = true,
      current = "";
    setLogo("");
    if (design.logoId)
      api
        .asset(design.logoId)
        .then((url) => {
          if (!active) return URL.revokeObjectURL(url);
          current = url;
          setLogo(url);
        })
        .catch(() => {
          if (active) setError("The selected logo could not be previewed.");
        });
    return () => {
      active = false;
      if (current) URL.revokeObjectURL(current);
    };
  }, [api, design.logoId]);
  function edit(patch: Partial<SignupDesign>) {
    setDesign({ ...design, ...patch });
    key.current = operationKey();
    setNotice("");
    setError("");
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.call<{ revision: number }>(
        "audienceOnboarding.saveDesign",
        {
          brandId: view.brandId,
          expectedRevision: revision,
          design,
          operationKey: key.current,
        },
      );
      setRevision(result.revision);
      key.current = operationKey();
      setNotice("Design saved for " + view.brandName + ".");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save the design.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="design-studio">
      <summary>Design studio · Signup page</summary>
      <div className="studio-columns">
        <div>
          <h3>Brand identity</h3>
          <fieldset disabled={busy}>
            <label>
              Display name
              <input
                maxLength={100}
                placeholder={view.brandName}
                value={design.displayName}
                onChange={(e) => edit({ displayName: e.target.value })}
              />
            </label>
            <label>
              Brand logo
              <select
                value={design.logoId ?? ""}
                onChange={(e) => edit({ logoId: e.target.value || null })}
              >
                <option value="">Flockletter postage</option>
                {library.assets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="help">
              Your display name, logo, accent color and typeface appear on your signup page and confirmation email. Your signup address stays the same when you edit them.
            </p>
            <BrandImageUpload
              api={api}
              brandId={view.brandId}
              onUploaded={library.accept}
            />
            {library.error && <p role="alert">{library.error}</p>}
            <label>
              Button color
              <input
                type="color"
                value={design.accent}
                onChange={(e) => edit({ accent: e.target.value })}
              />
            </label>
            <label>
              Heading typeface
              <select
                value={design.font}
                onChange={(e) =>
                  edit({ font: e.target.value as SignupDesign["font"] })
                }
              >
                <option value="serif">Serif</option>
                <option value="sans">Sans serif</option>
              </select>
            </label>
            <h3>Signup page</h3>
            <label>
              Headline
              <input
                maxLength={120}
                value={design.heading}
                placeholder={"News from " + view.brandName}
                onChange={(e) => edit({ heading: e.target.value })}
              />
            </label>
            <label>
              Introduction
              <textarea
                maxLength={400}
                value={design.introduction}
                onChange={(e) => edit({ introduction: e.target.value })}
              />
            </label>
            <button className="btn" type="button" onClick={() => void save()}>
              {busy ? "Saving…" : "Save design"}
            </button>
          </fieldset>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </div>
        <div
          style={
            {
              "--postcard-accent": design.accent,
              "--postcard-ink": buttonInk(design.accent),
            } as CSSProperties
          }
        >
          <h3>Page preview</h3>
          <SignupPostcard
            design={design}
            brandName={view.brandName}
            logo={logo}
            title={design.heading || "News from " + view.brandName}
            footer={
              (view.confirmationMode === "single_opt_in"
                ? "No email confirmation is required. You can unsubscribe from any newsletter."
                : "Email confirmation is required.") + " Tracking is off."
            }
          >
            {design.introduction && <p>{design.introduction}</p>}
            <SignupFields
              preview
              version={view.policyVersion}
              consent={
                view.consentText || "Your signup consent wording appears here."
              }
            />
          </SignupPostcard>
        </div>
      </div>
    </details>
  );
}
