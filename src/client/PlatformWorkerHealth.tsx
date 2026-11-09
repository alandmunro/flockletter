import type { CustomerWorkerHeartbeat } from '../shared/customer-operations.js';

export function PlatformWorkerHealth({ heartbeat }: { heartbeat?: CustomerWorkerHeartbeat | null }) {
  const state = heartbeat?.state;

  let statusLabel: string;
  switch (state) {
    case 'fresh':
      statusLabel = 'Recent heartbeat';
      break;
    case 'stale':
      statusLabel = 'Heartbeat expired';
      break;
    case 'stopped':
      statusLabel = 'Worker reported stopped';
      break;
    default:
      statusLabel = 'Not verified';
  }

  return (
    <div>
      <p>{statusLabel}</p>
      {heartbeat && (
        <>
          <p>Kind: {heartbeat.kind}</p>
          <p>Last heartbeat: {heartbeat.lastHeartbeat ?? '—'}</p>
          <p>Observed at: {heartbeat.observedAt}</p>
        </>
      )}
      <p>Snapshot only; queue progress is shown separately.</p>
    </div>
  );
}
