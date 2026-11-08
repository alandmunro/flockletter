import { spawn } from 'node:child_process';

export function writePublicSupportFacts(facts: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'llm',
      [
        '-s',
        'Draft a concise support email using only the supplied public facts. Do not promise a refund, access or an action. /no_think',
        facts,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    let exceededLimit = false;
    const stop = () => {
      exceededLimit = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, 600000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (part) => {
      if (exceededLimit) return;
      if (output.length + part.length > 5000) return stop();
      output += part;
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(Error('The configured local llm command is unavailable.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || exceededLimit) return reject(Error('The local model did not return a bounded draft.'));
      resolve(output);
    });
  });
}
