import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ContactPage } from "../shared/audience.js";
import { operationKey, type Api } from "./api.js";

export function PendingContactApproval({
  api,
  brandId,
  policyVersion,
  enabled,
  onChanged,
}: {
  api: Api;
  brandId: string;
  policyVersion: string;
  enabled: boolean;
  onChanged: () => void;
}) {
  const [page, setPage] = useState<ContactPage>(),
    [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]),
    [source, setSource] = useState("");
  const [permission, setPermission] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [revision, setRevision] = useState(0),
    [notice, setNotice] = useState("");
  const pending = useRef<{ signature: string; key: string }>(undefined),
    inFlight = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setPage(undefined);
    setSelected([]);
    setPermission(false);
    api
      .call<ContactPage>("audience.list", {
        brandId,
        state: "pending",
        limit: 50,
        ...(cursor ? { cursor } : {}),
      })
      .then((value) => {
        if (current) setPage(value);
      })
      .catch((cause) => {
        if (current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load pending contacts.",
          );
      });
    return () => {
      current = false;
    };
  }, [api, brandId, cursor, revision]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !permission || !source.trim() || !selected.length)
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const input = {
      brandId,
      subscriberIds: selected,
      policyVersion,
      source: source.trim(),
      permissionAffirmed: true,
    };
    const signature = JSON.stringify(input);
    if (pending.current?.signature !== signature)
      pending.current = { signature, key: operationKey() };
    try {
      const value = await api.call<{ results: { outcome: string }[] }>(
        "audienceOnboarding.confirmContacts",
        { ...input, operationKey: pending.current.key },
      );
      if (!alive.current) return;
      pending.current = undefined;
      setNotice(
        value.results
          .map((item) => item.outcome.replaceAll("_", " "))
          .join(" · "),
      );
      setSelected([]);
      setPermission(false);
      setCursor(undefined);
      setRevision((n) => n + 1);
      onChanged();
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The request could not be verified. Retry the same selection.",
        );
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <details>
      <summary>Subscribe existing pending contacts without email</summary>
      <p>
        Select only contacts who already gave this brand permission. This
        records your declaration; it does not verify their mailbox.
        Unsubscribed, bounced and complained contacts stay excluded.
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              setError("");
              setRevision((n) => n + 1);
            }}
          >
            Reload contacts
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy || !enabled}>
          <legend>Pending contacts</legend>
          {!page ? (
            <p role="status">Loading pending contacts…</p>
          ) : !page.items.length ? (
            <p>No pending contacts on this page.</p>
          ) : (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={selected.length === page.items.length}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? page.items.map((item) => item.id) : [],
                    )
                  }
                />{" "}
                Select this page ({page.items.length})
              </label>
              {page.items.map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(item.id)}
                    onChange={(e) =>
                      setSelected((ids) =>
                        e.target.checked
                          ? [...ids, item.id]
                          : ids.filter((id) => id !== item.id),
                      )
                    }
                  />{" "}
                  {item.email}
                </label>
              ))}
            </>
          )}
          <div className="actions">
            {cursor && (
              <button
                type="button"
                className="btn secondary"
                onClick={() => setCursor(undefined)}
              >
                First pending page
              </button>
            )}
            {page?.nextCursor && (
              <button
                type="button"
                className="btn secondary"
                onClick={() => setCursor(page.nextCursor!)}
              >
                Next pending page
              </button>
            )}
          </div>
          <label>
            Permission source for selected contacts
            <input
              required
              minLength={3}
              maxLength={250}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="In-store newsletter signup"
            />
          </label>
          <label>
            <input
              type="checkbox"
              required
              checked={permission}
              onChange={(e) => setPermission(e.target.checked)}
            />{" "}
            I have permission to email these selected contacts for this brand.
          </label>
          <button
            type="submit"
            className="btn"
            disabled={!selected.length || !permission || !page}
          >
            {busy
              ? "Saving…"
              : `Subscribe ${selected.length} selected without email`}
          </button>
        </fieldset>
      </form>
    </details>
  );
}
