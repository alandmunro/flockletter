import { useEffect, useState } from 'react';
import type { PlatformApi } from './platform-api.js';
import { operationKey } from './api.js';

export type ReviewerCase = {
  id: string;
  revision: number;
  document: string;
  assignedToMe: boolean;
  closed: boolean;
  hold: { reason: string; reviewAt: string } | null;
};
export function TextingEvidenceCase({
  item,
  workspaceId,
  companyId,
  api,
  run,
  busy,
}: {
  item: ReviewerCase;
  workspaceId: string;
  companyId: string;
  api: PlatformApi;
  run: (action: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [letter, setLetter] = useState(''),
    [reason, setReason] = useState('carrier_appeal'),
    [reviewAt, setReviewAt] = useState('');
  useEffect(() => {
    if (!letter) return;
    const timer = setTimeout(() => setLetter(''), 5 * 60_000);
    return () => clearTimeout(timer);
  }, [letter]);
  const act = (action: 'claim' | 'view' | 'hold' | 'release_hold') =>
    run(async () => {
      setLetter('');
      const result = await api.call<{ contents?: string }>('platform.textingEvidenceCase', {
        action,
        workspaceId,
        companyId,
        caseId: item.id,
        operationKey: operationKey(),
        ...(action === 'hold' && {
          holdReason: reason,
          reviewAt: new Date(reviewAt).toISOString(),
        }),
      });
      if (result.contents) setLetter(result.contents);
    });
  return (
    <fieldset disabled={busy}>
      <legend>
        Practice {item.document} · revision {item.revision}
      </legend>
      {item.closed && <p>Review closed. The original is scheduled for deletion.</p>}
      {item.hold && (
        <p>
          {item.hold.reason === 'legal_hold' ? 'Legal hold' : 'Carrier appeal'} · review due{' '}
          {new Date(item.hold.reviewAt).toLocaleString()}
        </p>
      )}
      {item.assignedToMe ? (
        <>
          <button type="button" className="btn secondary" onClick={() => void act('view')}>
            Open assigned practice letter
          </button>
          {!!letter && (
            <>
              <pre>{letter}</pre>
              <button className="btn secondary" onClick={() => setLetter('')}>
                Hide letter
              </button>
            </>
          )}
          <details>
            <summary>Original retention</summary>
            <label>
              Reason to retain the original
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="carrier_appeal">Open carrier appeal</option>
                <option value="legal_hold">Legal hold</option>
              </select>
            </label>
            <label>
              Next review time
              <input type="datetime-local" value={reviewAt} onChange={(e) => setReviewAt(e.target.value)} />
            </label>
            <button className="btn secondary" disabled={!reviewAt} onClick={() => void act('hold')}>
              {item.hold ? 'Renew hold' : 'Place hold'}
            </button>
            {item.hold && (
              <button className="btn secondary" onClick={() => void act('release_hold')}>
                Release hold
              </button>
            )}
          </details>
        </>
      ) : (
        <button className="btn secondary" onClick={() => void act('claim')}>
          Take responsibility for this case
        </button>
      )}
    </fieldset>
  );
}
