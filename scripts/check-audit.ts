import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { evaluateAudit, parseAuditReport, validateExceptions } from './audit-policy.js';

function audit(args: string[]) {
  const result = spawnSync('npm', ['audit', '--json', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const scope = args.includes('--omit=dev') ? 'production' : 'full';
  // npm can exit 1 for either findings or a failed request. Require a valid report
  // in both cases rather than interpreting a registry error object as clean.
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`npm audit (${scope}) did not complete normally`);
  }
  try {
    return parseAuditReport(result.stdout);
  } catch (error) {
    throw new Error(`npm audit (${scope}): ${error instanceof Error ? error.message : 'invalid report'}`, { cause: error });
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
