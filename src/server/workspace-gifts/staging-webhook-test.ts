import { z } from 'zod';
import type { Database } from '../db.js';
import { verifyRuntimeBoundary } from '../runtime-boundary.mjs';

const staging = 'https://flockletter-staging.onrender.com';
const hooks = 'https://testflight.tremendous.com/api/v2/webhooks';
const webhook = z.object({ id: z.string().regex(/^[A-Z0-9]{4,20}$/), url: z.string() });

// An operator supplies a fresh request ID on the staging web service. Recording it before
// the POST prevents overlapping deployments from triggering two provider events.
export async function requestStagingWebhookTest(db: Database, env: NodeJS.ProcessEnv) {
  const requestId = env.FLOCKLETTER_GIFT_WEBHOOK_TEST_ID;
  if (!requestId || env.APP_ENV !== 'staging' || env.APP_ORIGIN !== staging) return;
  if (!z.uuid().safeParse(requestId).success || !/^TEST_\S+$/.test(env.TREMENDOUS_SANDBOX_API_KEY ?? '') ||
      (env.FLOCKLETTER_GIFT_TREMENDOUS_WEBHOOK_SECRET?.length ?? 0) < 16)
    throw Error('Invalid staging test configuration');

  await verifyRuntimeBoundary(db.pool, { database: 'flockletter_staging', role: 'flockletter_staging_runtime' });
  const headers = { Authorization: 'Bearer ' + env.TREMENDOUS_SANDBOX_API_KEY, 'Content-Type': 'application/json' };
  const lookup = await fetch(hooks, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!lookup.ok) throw Error('Tremendous webhook lookup failed');
  const { webhooks: [destination] } = z.object({ webhooks: z.tuple([webhook]) }).parse(await lookup.json());
  if (destination.url !== staging + '/api/v1/workspace-gifts/tremendous-events')
    throw Error('Tremendous webhook points elsewhere');

  const claimed = await db.tenant('system:workspace-gifts:provider-events', sql => sql.query(
    `INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result)
     VALUES(current_setting('app.workspace_id'),'workspace-gifts:staging-webhook-test',$1,$1,'{}'::jsonb)
     ON CONFLICT DO NOTHING RETURNING operation_key`, [requestId],
  ));
  if (!claimed.rowCount) return;
  const response = await fetch(hooks + '/' + destination.id + '/simulate', {
    method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ event: 'ORDERS.CREATED' }),
  });
  // Simulation submission and signed inbound delivery have separate receipts.
  console.info('Tremendous staging webhook test submission HTTP', response.status);
}
