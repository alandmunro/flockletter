import type { SignupDesign } from "./signup-design.js";

export function ConfirmationFormContent({ design, brandName, photoUrl, token, fragmentAction }: {
  design: SignupDesign;
  brandName: string;
  photoUrl?: string;
  token?: string;
  fragmentAction?: boolean;
}) {
  const confirmation = design.confirmation;
  return (
    <form method="post">
      {photoUrl && <img className="confirmation-photo" src={photoUrl} alt="" />}
      <p>{confirmation?.message || "Confirm that you want email from " + (design.displayName || brandName) + "."}</p>
      {token && <input type="hidden" name="token" value={token} />}
      <button type={token || fragmentAction ? "submit" : "button"} disabled={!token}>
        {confirmation?.button || "Confirm subscription"}
      </button>
    </form>
  );
}
