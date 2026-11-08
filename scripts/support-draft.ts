import { writePublicSupportFacts } from './support-local-writer.js';
import { supportTopics, type SupportTopic } from '../src/shared/support.js';
import { supportDraft } from '../src/server/support-draft.js';

const topic = process.argv[2] as SupportTopic;
if (!supportTopics.includes(topic)) throw Error('Choose one of the documented support topics.');
const result = await supportDraft(topic, writePublicSupportFacts);
console.log(JSON.stringify(result, null, 2));
