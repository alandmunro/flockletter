#!/usr/bin/env node
// Wait until every given Flockletter address reports the expected commit and environment and is ready.
// Used by the production promotion workflow before and after the deploy. Prints no credentials: the
// endpoints it reads are public.
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL, URL } from 'node:url';
import { parseArgs } from 'node:util';

const SHA = /^[0-9a-f]{40}$/;
const ENVIRONMENTS = new Set(['staging', 'production']);

async function readJson(fetchImpl, url, path) {
  try {
    const response = await fetchImpl(new URL(path, url), { headers: { accept: 'application/json' }, signal: globalThis.AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch (error) {
    return { status: 0, body: null, error: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

/** One pass over every address. Returns the reasons it is not yet verified (empty when it is). */
export async function checkOnce({ urls, environment, expectedSha, fetchImpl = globalThis.fetch }) {
  const failures = [];
  for (const url of urls) {
    const version = await readJson(fetchImpl, url, '/api/health/version');
    const ready = await readJson(fetchImpl, url, '/readyz');
    const v = version.status === 200 && version.body && typeof version.body === 'object' ? version.body : null;
    if (!v) failures.push(`${url}: /api/health/version is not available (HTTP ${version.status})`);
    else if (v.appId !== 'flockletter' || v.environment !== environment) failures.push(`${url}: identity is ${v.appId}/${v.environment}, expected flockletter/${environment}`);
    else if (v.buildSha !== expectedSha) failures.push(`${url}: serving ${String(v.buildSha ?? 'no commit').slice(0, 12)}, expected ${expectedSha.slice(0, 12)}`);
    if (!(ready.status === 200 && ready.body?.ready === true && Array.isArray(ready.body.gaps) && ready.body.gaps.length === 0)) {
      failures.push(`${url}: not ready (HTTP ${ready.status}${Array.isArray(ready.body?.gaps) && ready.body.gaps.length ? `; ${ready.body.gaps.join(', ')}` : ''})`);
    }
  }
  return failures;
}

export async function verifyRelease({ urls, environment, expectedSha, timeoutMs = 180000, intervalMs = 5000,
  fetchImpl = globalThis.fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!urls.length) throw new Error('at least one --url is required');
  if (!ENVIRONMENTS.has(environment)) throw new Error('environment must be staging or production');
  if (!SHA.test(expectedSha)) throw new Error('expected commit must be a full lowercase SHA');
  const deadline = now() + timeoutMs;
  let failures;
  for (;;) {
    failures = await checkOnce({ urls, environment, expectedSha, fetchImpl });
    if (!failures.length) return { ok: true, failures: [] };
    if (now() >= deadline) return { ok: false, failures };
    await sleep(intervalMs);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: {
    url: { type: 'string', multiple: true }, environment: { type: 'string' },
    'expected-sha': { type: 'string' }, 'timeout-ms': { type: 'string', default: '180000' } } });
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) {
    console.error('timeout must be 1000..900000 ms');
    process.exit(2);
  }
  try {
    const result = await verifyRelease({ urls: values.url ?? [], environment: values.environment, expectedSha: values['expected-sha'] ?? '', timeoutMs });
    if (!result.ok) {
      console.error(`release verification failed:\n${result.failures.map(f => `  - ${f}`).join('\n')}`);
      process.exit(1);
    }
    console.log(`verified ${values['expected-sha'].slice(0, 12)} on ${values.url.join(', ')} (${values.environment})`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
