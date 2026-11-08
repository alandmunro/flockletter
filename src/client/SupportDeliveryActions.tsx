type SupportDeliveryActionsProps = {
  busy: boolean;
  mode: "off" | "capture" | "live";
  state: string;
  delivery: { state: string; attempts: number; reason: string | null } | null;
  canApprove: boolean;
  canRenew: boolean;
  canProcess: boolean;
  onApprove: () => void;
  onRenew: () => void;
  onProcess: () => void;
  onRefresh: () => void;
};

export function SupportDeliveryActions({
  busy,
  mode,
  state,
  delivery,
  canApprove,
  canRenew,
  canProcess,
  onApprove,
  onRenew,
  onProcess,
  onRefresh,
}: SupportDeliveryActionsProps) {
  const disabled = busy || mode === "off";

  return (
    <section className="card" aria-labelledby="support-delivery-actions">
      <h3 id="support-delivery-actions">Reply delivery</h3>

      {mode === "capture" && (
        <p>No email is sent.</p>
      )}
      {mode === "live" && (
        <p>An approved submission can send real email.</p>
      )}
      {mode === "off" && (
        <p>Unavailable.</p>
      )}

      <p>Conversation: {state.replaceAll("_", " ")}</p>
      {delivery && (
        <>
          <p>Delivery: {delivery.state.replaceAll("_", " ")}</p>
          <p>Attempts: {delivery.attempts}</p>
          {delivery.reason && (
            <p>Reason: {delivery.reason.replace(/_/g, " ")}</p>
          )}
        </>
      )}

      <div className="actions">
        <button
          type="button"
          className="btn secondary"
          onClick={onRefresh}
          disabled={busy}
        >
          Refresh conversation
        </button>

        {canApprove && (
          <button
            type="button"
            className="btn"
            onClick={onApprove}
            disabled={disabled}
          >
            {mode === "live"
              ? "Approve and send saved reply"
              : "Approve and capture saved reply"}
          </button>
        )}

        {canRenew && (
          <button
            type="button"
            className="btn secondary"
            onClick={onRenew}
            disabled={disabled}
          >
            Renew authority for this exact queued reply
          </button>
        )}

        {canProcess && (
          <button
            type="button"
            className="btn secondary"
            onClick={onProcess}
            disabled={disabled}
          >
            Process approved reply or check receipt
          </button>
        )}
      </div>

      <p>
        Renewing authority never changes or sends a reply; uncertain attempts use receipt lookup without resending.
      </p>
    </section>
  );
}
