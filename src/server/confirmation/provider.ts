import { z } from 'zod';
import type { IntakeBinding } from '../subscribers/config.js';

export type ConfirmationMessage = { to: string; from: string; confirm: string; unsubscribe: string };
export type DispatchOutcome =
  { kind: 'accepted' | 'captured'; id: string } | { kind: 'retry' | 'ambiguous' | 'rejected' | 'conflict' };
export interface ConfirmationProvider {
  readonly mode: 'capture' | 'live';
  deliver(operation: string, message: ConfirmationMessage): Promise<DispatchOutcome>;
}

// Synthetic mailbox for a deliberately allowlisted, non-delivering test process.
export class CapturedConfirmation implements ConfirmationProvider {
  readonly mode = 'capture';
  readonly messages = new Map<string, ConfirmationMessage>();
  async deliver(operation: string, message: ConfirmationMessage): Promise<DispatchOutcome> {
    if (!this.messages.has(operation)) {
      if (this.messages.size >= 1000) this.messages.delete(this.messages.keys().next().value!);
      this.messages.set(operation, message);
    }
    return { kind: 'captured', id: operation };
  }
}
export class ResendConfirmation implements ConfirmationProvider {
  readonly mode = 'live';
  constructor(
    private readonly apiKey: string,
    private readonly send: typeof fetch = fetch,
  ) {}
  async deliver(operation: string, message: ConfirmationMessage): Promise<DispatchOutcome> {
    try {
      const result = await this.send('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          authorization: 'Bearer ' + this.apiKey,
          'content-type': 'application/json',
          'Idempotency-Key': 'ffa-confirmation/' + operation,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: 'Confirm your Frosty Flamingo Apparel newsletter subscription',
          text: `Confirm your request for Frosty Flamingo Apparel product emails:\n\n${message.confirm}\n\nIf you did not request this, ignore this message or opt out:\n\n${message.unsubscribe}`,
          tags: [{ name: 'flockletter_job', value: operation }],
        }),
      });
      if (result.ok) {
        const body = await result.json();
        return z.uuid().safeParse(body.id).success
          ? { kind: 'accepted', id: body.id }
          : { kind: 'ambiguous' };
      }
      if (result.status === 429) return { kind: 'retry' };
      if (result.status === 409) {
        const body = await result.json().catch(() => null);
        return { kind: body?.name === 'concurrent_idempotent_requests' ? 'ambiguous' : 'conflict' };
      }
      return { kind: result.status >= 500 || result.status === 408 ? 'ambiguous' : 'rejected' };
    } catch {
      return { kind: 'ambiguous' };
    }
  }
}
export function configuredProvider(binding: IntakeBinding, env: NodeJS.ProcessEnv): ConfirmationProvider {
  if (binding.mode === 'capture') return new CapturedConfirmation();
  const key = env.FLOCKLETTER_CONFIRMATION_RESEND_KEY;
  if (!key) throw new Error('The Flockletter confirmation worker needs its own provider credential.');
  return new ResendConfirmation(key);
}
