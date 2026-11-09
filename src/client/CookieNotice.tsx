import type { CookieDecision } from "../shared/cookie-consent.js";

interface CookieNoticeProps {
  open: boolean;
  decision: CookieDecision | null;
  error: string;
  onChoose: (choice: CookieDecision) => void;
  onClose: () => void;
  signal: boolean;
}

export function CookieNotice({ open, decision, error, onChoose, onClose, signal }: CookieNoticeProps) {
  const handleChoices = () => {
    window.dispatchEvent(new CustomEvent("flockletter:cookie-choices"));
  };

  return (
    <div className="cookie-controls" role="region" aria-label="Privacy controls">
      <a href="/privacy">Privacy &amp; cookies</a>
      <button type="button" aria-expanded={open} aria-controls="flockletter-cookie-notice" onClick={handleChoices}>
        Cookie choices
      </button>

      {open && (
        <section id="flockletter-cookie-notice" className="cookie-notice" aria-labelledby="cookie-notice-title">
          <h2 id="cookie-notice-title">Your privacy, your choice.</h2>
          <p>Necessary cookies and browser storage keep sign-in secure and remember your choices.</p>
          <p>Optional cookies stay off unless you accept them. Rejecting optional cookies does not affect using Flockletter.</p>
          <p>Optional analytics and advertising cookies are not currently used. Accept all covers only the uses listed in this notice.</p>
          <a href="/privacy">Read about cookies and privacy</a>

          {signal && <p>Your browser privacy signal is on. Optional tracking stays off.</p>}

          {error && <p role="alert">{error}</p>}

          <div className="cookie-notice-actions">
            <button type="button" className="cookie-choice" onClick={() => onChoose("reject")}>
              Reject optional cookies
            </button>
            <button type="button" className="cookie-choice" onClick={() => onChoose("accept")}>
              Accept all cookies
            </button>
          </div>

          {decision !== null && (
            <button type="button" className="cookie-close" onClick={onClose}>
              Close
            </button>
          )}
        </section>
      )}
    </div>
  );
}
