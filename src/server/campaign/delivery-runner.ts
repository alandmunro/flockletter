import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { captureBinding } from './worker.js';
import { workspaceIdentifier } from './rehearsal.js';

export type DeliveryBinding = { workspace: string; brand: string };
const bindingsSchema = z
  .array(
    z.object({ workspace: workspaceIdentifier, brand: z.uuid().transform((v) => v.toLowerCase()) }).strict(),
  )
  .max(20);
export function deliveryBindings(env: NodeJS.ProcessEnv): DeliveryBinding[] {
  const legacy = captureBinding(env);
  const value = env.FLOCKLETTER_DELIVERY_BINDINGS;
  const extra = value === undefined ? [] : bindingsSchema.parse(JSON.parse(value));
  const distinct = new Map<string, DeliveryBinding>();
  for (const b of [...(legacy ? [legacy] : []), ...extra]) distinct.set(b.workspace + '/' + b.brand, b);
  if (distinct.size > 20) throw new Error('The staging worker supports up to 20 explicit brand bindings.');
  return [...distinct.values()];
}

type Tick = (workspace: string, brand: string) => Promise<{ processed: boolean }>;
export async function runDeliveryQueue(
  bindings: readonly DeliveryBinding[],
  tick: Tick,
  stop: AbortSignal,
  onFailure = () =>
    console.error('A staging delivery scope could not be processed; it will be checked again.'),
  wait = (signal: AbortSignal) => pause(15000, undefined, { signal }).catch(() => {}),
) {
  if (!bindings.length) throw new Error('The staging worker requires at least one explicit brand binding.');
  while (!stop.aborted) {
    const failed = new Set<DeliveryBinding>();
    // Rotate through scopes before draining a large campaign. Never poll after shutdown.
    for (let round = 0; round < 25 && !stop.aborted; round++) {
      let busy = false;
      for (const b of bindings) {
        if (stop.aborted || failed.has(b)) continue;
        try {
          if ((await tick(b.workspace, b.brand)).processed) busy = true;
        } catch {
          failed.add(b);
          onFailure();
        }
      }
      if (!busy) break;
    }
    if (!stop.aborted) await wait(stop);
  }
}
