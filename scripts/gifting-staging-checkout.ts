// Run in a private, authorized Flockletter staging shell from the release checkout.
// advance -> checkout-link (private interactive TTY only) -> genuine browser payment -> advance.
// status reads the last durable operator result without contacting either provider.
import { Database } from '../src/server/db.js';
import { operateCheckoutProof, readCheckoutProofStage, type CheckoutProofStage } from '../src/server/workspace-gifts/checkout-proof.js';

async function main(): Promise<{ stage: CheckoutProofStage }> {
  const [action, ...rest] = process.argv.slice(2);
  if (rest.length || (action !== 'advance' && action !== 'checkout-link' && action !== 'status'))
    return { stage: 'invalid_command' };
  if (process.env.APP_ENV !== 'staging' || process.env.APP_ORIGIN !== 'https://flockletter-staging.onrender.com')
    return { stage: 'target_blocked' };
  if (action === 'checkout-link' && (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY || process.env.CI))
    return { stage: 'private_terminal_required' };
  const connection = new URL(process.env.DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(connection.protocol) || connection.pathname !== '/flockletter_staging'
    || connection.username !== 'flockletter_staging_runtime') return { stage: 'target_blocked' };
  const db = new Database(connection.href, 1);
  try {
    return action === 'status' ? await readCheckoutProofStage(db) : await operateCheckoutProof(db, action);
  } finally {
    await db.close();
  }
}

const result = await main().catch(() => ({ stage: 'target_blocked' as const }));
console.log(JSON.stringify(result));
if (!['passed', 'not_started', 'awaiting_browser_payment', 'private_link_displayed'].includes(result.stage))
  process.exitCode = 1;
