import { supportAnswer, type SupportTopic } from '../shared/support.js';
export type LocalWriter = (facts: string) => Promise<string>;
// Operator selects a public topic. No inbound email body, sender, attachment or account record enters the model prompt.
export async function supportDraft(topic: SupportTopic, write: LocalWriter) {
  const guidance = supportAnswer(topic);
  if (!guidance) return { kind: 'human_review' as const, topic, draft: null, automaticSend: false };
  const output = (await write(guidance.text)).trim();
  const control = /\p{Cc}/u.test(output.replaceAll(/[\t\n\r]/g, ''));
  if (!output || output.length > 2500 || control || /<\/?think>/i.test(output))
    throw Error('The local draft needs another review.');
  const draft = output + '\n\nThis reply was drafted with AI assistance.';
  return { kind: 'draft' as const, topic, draft, approvedFacts: guidance.text, automaticSend: false };
}
