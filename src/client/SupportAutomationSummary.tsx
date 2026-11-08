import type { SupportAutomationStatus } from "../shared/customer-support.js";

interface SupportAutomationSummaryProps {
  status: SupportAutomationStatus;
  onRefresh: () => void;
  busy: boolean;
}

export function SupportAutomationSummary({ status, onRefresh, busy }: SupportAutomationSummaryProps) {
  const { mode, policyVersion, enabledTopics, pending, captured, uncertain, lastReason, writerConfigured } = status;

  const isCaptureMode = mode === "capture";
  const lastReasonText = lastReason ? lastReason.replace(/_/g, " ") : null;

  return (
    <section className="card" aria-labelledby="support-automation-title">
      <h3 id="support-automation-title">Automated support</h3>

      {isCaptureMode && (
        <p>In capture mode, no emails are sent. The exercise records the same policy decision and delivery receipt without sending email.</p>
      )}

      <dl>
        <dt>Policy version</dt>
        <dd>{policyVersion !== null ? policyVersion : "—"}</dd>

        <dt>Enabled topics</dt>
        <dd>{enabledTopics.length > 0 ? enabledTopics.join(", ") : "None"}</dd>

        <dt>Pending</dt>
        <dd>{pending}</dd>

        <dt>Captured</dt>
        <dd>{captured}</dd>

        <dt>Uncertain</dt>
        <dd>{uncertain}</dd>

        <dt>Writer</dt>
        <dd>{writerConfigured ? "Configured" : "Not configured"}</dd>
      </dl>

      {lastReasonText && <p>{lastReasonText}</p>}

      <button className="btn secondary" onClick={onRefresh} disabled={busy}>
        Refresh automation
      </button>
    </section>
  );
}
