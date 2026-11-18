import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { evaluateAudit, validateExceptions } from './audit-policy.js';

function audit(args: string[]) {
  const result = spawnSync('npm', ['audit', '--json', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit ${args.join(' ')} did not return JSON: ${result.stderr.slice(0, 500)}`);
  }
}

const exceptions = validateExceptions(JSON.parse(readFileSync(new URL('./audit-exceptions.json', import.meta.url), 'utf8')));
const verdict = evaluateAudit({
  production: audit(['--omit=dev']),
  full: audit([]),
  exceptions,
  today: new Date().toISOString().slice(0, 10),
});

for (const warning of verdict.warnings) console.log(`audit: ${warning}`);
for (const error of verdict.errors) console.error(`audit: ${error}`);
if (verdict.errors.length > 0) process.exit(1);
console.log('audit: passed (production dependencies have no moderate or higher advisories)');
