import { isSupportScenario, openSupportInbox, supportSamples } from './support-inbox-store.js';
import { writePublicSupportFacts } from './support-local-writer.js';

const usage = [
  'Flockletter synthetic support inbox',
  'Set FLOCKLETTER_SUPPORT_REHEARSAL_DIR to a private local directory.',
  'receive <mail-id> <scenario>     Capture a fictional incoming message',
  'ingest                           Read a synthetic JSON email envelope from standard input',
  'list                            Show ticket states',
  'show <mail-id>                  Read the conversation, history and draft',
  'acknowledge <mail-id>           Capture an acknowledgment',
  'draft <mail-id>                 Prepare a reply or refer the ticket to a person',
  'approve <mail-id> <review-code> Capture the reviewed draft',
  'escalate <mail-id>              Refer to a person for review',
  'close <mail-id>                 Close an approved or escalated ticket',
  'Scenarios: ' + Object.keys(supportSamples).join(', '),
].join('\n');

async function readEnvelope() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) throw Error('The support envelope exceeds 16 KiB.');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw Error('The synthetic support envelope must be valid JSON.');
  }
}

async function run(args: string[]) {
  const [command, id, argument] = args;
  if (!command || command === '--help') return usage;
  const directory = process.env.FLOCKLETTER_SUPPORT_REHEARSAL_DIR;
  if (!directory || !['local', 'test', 'staging'].includes(process.env.APP_ENV ?? 'local')
      || (!process.env.APP_ENV && process.env.NODE_ENV === 'production'))
    throw Error('Select a private support rehearsal directory in a local, test or staging environment.');
  const inbox = openSupportInbox(directory);
  try {
    if (command === 'list' && args.length === 1) return { tickets: inbox.list() };
    if (command === 'ingest' && args.length === 1) return inbox.ingest(await readEnvelope());
    if (!id) throw Error(usage);
    if (args.length === 2) {
      if (command === 'show') return inbox.get(id);
      if (command === 'draft') return await inbox.prepare(id, writePublicSupportFacts);
      if (command === 'acknowledge' || command === 'escalate' || command === 'close') return inbox.act(id, command);
    }
    if (args.length === 3 && argument) {
      if (command === 'receive' && isSupportScenario(argument)) return inbox.receive(id, argument);
      if (command === 'approve') return inbox.act(id, 'approve', argument);
    }
    throw Error(usage);
  } finally {
    inbox.close();
  }
}

try {
  const result = await run(process.argv.slice(2));
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The support rehearsal command failed.');
  process.exitCode = 1;
}
