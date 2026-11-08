import { z } from 'zod';

export type SupportEnvelope = {
  operationKey: string;
  workspaceId: string;
  to: string;
  from: string;
  subject: string;
  text: string;
};
export type SupportSubmission = { state: 'accepted'; id: string } | { state: 'unknown' | 'rejected' };
export interface SupportProvider {
  submit(message: SupportEnvelope): Promise<SupportSubmission>;
  lookup(operationKey: string, providerId: string | null): Promise<SupportSubmission>;
}

export class ResendSupportProvider implements SupportProvider {
  constructor(
    private readonly key: string,
    private readonly send: typeof fetch = fetch,
  ) {
    if (!key.trim()) throw Error('Configure a dedicated support email credential.');
  }
  async submit(message: SupportEnvelope): Promise<SupportSubmission> {
    try {
      const response = await this.send('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          authorization: 'Bearer ' + this.key,
          'content-type': 'application/json',
          'Idempotency-Key': 'flockletter-support/' + message.operationKey,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          tags: [{ name: 'fl_support', value: message.operationKey }],
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          state: response.status >= 500 || [408, 409, 429].includes(response.status) ? 'unknown' : 'rejected',
        };
      }
      const result = z.object({ id: z.uuid() }).safeParse(await response.json());
      return result.success ? { state: 'accepted', id: result.data.id } : { state: 'unknown' };
    } catch {
      return { state: 'unknown' };
    }
  }
  async lookup(_operation: string, providerId: string | null): Promise<SupportSubmission> {
    if (!providerId || !z.uuid().safeParse(providerId).success) return { state: 'unknown' };
    try {
      const response = await this.send('https://api.resend.com/emails/' + providerId, {
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { authorization: 'Bearer ' + this.key },
      });
      const result = response.ok ? z.object({ id: z.uuid() }).safeParse(await response.json()) : null;
      if (!response.ok) await response.body?.cancel();
      return result?.success && result.data.id === providerId
        ? { state: 'accepted', id: providerId }
        : { state: 'unknown' };
    } catch {
      return { state: 'unknown' };
    }
  }
}
