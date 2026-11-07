import { spawn } from 'node:child_process';
import { supportTopics, type SupportTopic } from '../src/shared/support.js';
import { supportDraft } from '../src/server/support-draft.js';

const topic = process.argv[2] as SupportTopic;
if (!supportTopics.includes(topic)) throw Error('Choose one of the documented support topics.');
const result = await supportDraft(
  topic,
  async (facts) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        'llm',
        [
          '-s',
          'Draft a concise support email using only the supplied public facts. Do not promise a refund, access or an action. /no_think',
          facts,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let output = '',
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 600000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (part) => {
        output += part;
        if (output.length > 5000) child.kill();
      });
      child.on('error', () => {
        clearTimeout(timer);
        reject(Error('The configured local llm command is unavailable.'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || timedOut) return reject(Error('The local model did not return a bounded draft.'));
        resolve(output);
      });
    }),
);
console.log(JSON.stringify(result, null, 2));
