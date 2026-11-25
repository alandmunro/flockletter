import { z } from 'zod';
import { boundedJson } from '../customer-support/writer.js';
import type { Forward } from './messaging.js';

export const replyForwardingKey = 'FLOCKLETTER_TEXTING_REPLY_RESEND_KEY';

export function replyForwarder(apiKey: string | undefined, from: string | undefined, send: typeof fetch = fetch): Forward {
  const key = apiKey?.trim();
  const sender = z.email().safeParse(from);
  if (!key || !sender.success) throw Error('Text reply forwarding needs its Resend key and sender.');
  return async message => {
    const to = z.email().safeParse(message.to);
    if (!to.success) return 'failed';
    const response = await send('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/json',
        'Idempotency-Key': 'flockletter-sms-reply/' + message.id,
      },
      body: JSON.stringify({
        from: sender.data, to: [to.data], subject: message.subject, text: message.text,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return response.status >= 500 || [408, 409, 429].includes(response.status) ? 'uncertain' : 'failed';
    }
    return z.object({ id: z.uuid() }).safeParse(await boundedJson(response, 16384)).success
      ? 'forwarded' : 'uncertain';
  };
}
