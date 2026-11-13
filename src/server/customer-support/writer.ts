import { z } from 'zod';
import type { LocalWriter } from '../support-draft.js';
import { supportAnswer } from '../../shared/support.js';

export type SupportWriterConfig = {
  enabled: boolean;
  origin: string;
  allowedOrigins: string[];
  model: string;
  apiKey?: string;
};
/** Explicit operator configuration only. No caller-controlled URL or tenant content enters this adapter. */
export function configuredSupportWriter(config: SupportWriterConfig, send: typeof fetch = fetch): LocalWriter | undefined {
  if (!config.enabled) return undefined;
  const origin = new URL(config.origin);
  if (origin.origin !== config.origin || origin.username || origin.password ||
      !config.allowedOrigins.includes(origin.origin) ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) ||
      !config.model.trim() || config.model.length > 200) throw Error('Configure an explicitly allowed support writer origin and model.');
  const facts = new Set((['plans','trial','audience','campaigns'] as const).map((topic) => supportAnswer(topic)?.text));
  return async (guidance) => {
    if (!facts.has(guidance)) throw Error('The writer accepts approved public guidance only.');
    const response = await send(origin.origin + '/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}) },
      body: JSON.stringify({ model: config.model, temperature: 0.6, max_tokens: 2048, messages: [
        { role: 'system', content: 'Rewrite the supplied approved public guidance as a concise friendly support draft. Add no facts or promises. Never request credentials. Return only the draft, without reasoning or markup.' },
        { role: 'user', content: guidance },
      ] }),
    });
    const value = await boundedJson(response, 16384);
    const parsed = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1).max(2500) }) })).min(1).max(4) }).parse(value);
    return parsed.choices[0]!.message.content;
  };
}
export async function boundedJson(response: Response, limit: number, expectedErrorStatus?:number): Promise<unknown> {
  if ((!response.ok && response.status!==expectedErrorStatus) || Number(response.headers.get('content-length') ?? 0) > limit || !response.body) {
    await response.body?.cancel();
    throw Error('The support provider response is unavailable or exceeds its limit.');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) throw Error('The support provider response exceeds its limit.');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
