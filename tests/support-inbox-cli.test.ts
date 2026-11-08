import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('captures one reviewed CLI reply across independent processes using only approved facts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flockletter-support-cli-'));
  const prompt = join(directory, 'writer-prompt.json');
  const syntheticWriter = `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(prompt)}, JSON.stringify(process.argv.slice(2)));
console.log('Your account shares its monthly campaign allowance across its brands.');
`;
  writeFileSync(join(directory, 'llm'), syntheticWriter, { mode: 0o700 });
  function command(...args: string[]) {
    return spawnSync(process.execPath, ['--experimental-sqlite', '--import', 'tsx', 'scripts/support-inbox.ts', ...args], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, APP_ENV: 'test', FLOCKLETTER_SUPPORT_REHEARSAL_DIR: directory, PATH: directory + ':' + process.env.PATH },
    });
  }
  function run(...args: string[]) {
    const result = command(...args);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }
  try {
    run('receive', 'mail-example', 'plans');
    run('acknowledge', 'mail-example');
    const draft = run('draft', 'mail-example');
    expect(draft).toMatchObject({ state: 'drafted', facts: expect.stringContaining('Starter'), draft: expect.stringContaining('AI assistance') });
    expect(JSON.parse(readFileSync(prompt, 'utf8')).at(-1)).toBe(draft.facts);
    expect(command('approve', 'mail-example', 'old').status).toBe(1);
    expect(run('show', 'mail-example').state).toBe('drafted');
    run('approve', 'mail-example', draft.reviewCode);
    run('approve', 'mail-example', draft.reviewCode);
    run('close', 'mail-example');
    expect(run('show', 'mail-example')).toMatchObject({
      state: 'closed',
      messages: [{ kind: 'incoming_fixture' }, { kind: 'captured_acknowledgment' }, { kind: 'captured_reply', text: draft.draft }],
      history: ['received', 'acknowledged', 'drafted', 'approved', 'closed'].map(state => ({ state })),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
