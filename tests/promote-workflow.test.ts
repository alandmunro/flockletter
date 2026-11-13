import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without declarations
import { checkOnce, verifyRelease } from '../scripts/verify-release.mjs';

const workflow = readFileSync(new URL('../.github/workflows/promote-production.yml', import.meta.url), 'utf8');
const SHA = 'c'.repeat(40);

function steps() { return [...workflow.matchAll(/^ {6}- (?:name: (.+)|uses: (.+))$/gm)].map(m => m[1] ?? m[2] ?? ''); }
const index = (name: string) => steps().findIndex(s => s.startsWith(name));

describe('production promotion workflow', () => {
  it('is dispatch-only, serialized and least-privilege', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    const triggers = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\nconcurrency:'));
    expect(triggers).not.toMatch(/pull_request|push|schedule|workflow_run/);
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n {2}actions: read\n/);
    expect(workflow).toContain('group: flockletter-production');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain("run-name: Promote to production · ${{ inputs.request_id || 'manual' }}");
  });

  it('pins third-party actions to commit SHAs and exposes the Render key only to the deploy step', () => {
    for (const line of workflow.split('\n').filter(l => /uses:/.test(l))) expect(line).toMatch(/@[0-9a-f]{40} # v\d+/);
    // Only the read-only identity check and the deploy step receive the key.
    expect(workflow.match(/secrets\./g)).toHaveLength(2);
    const identity = workflow.slice(workflow.indexOf('- name: Confirm the Render service'), workflow.indexOf('- name: Deploy production'));
    const deploy = workflow.slice(workflow.indexOf('- name: Deploy production'), workflow.indexOf('- name: Verify production'));
    expect(identity).toContain('secrets.RENDER_API_KEY');
    expect(deploy).toContain('secrets.RENDER_API_KEY');
    expect(identity).not.toMatch(/-X POST|--request POST|render-deploy/);
  });

  it('checks the commit, staging and the migration gate before anything is deployed, then verifies production', () => {
    const order = ['Validate release inputs', 'Check out the trusted release tooling', 'Check out the exact release commit', 'Confirm the commit is on main',
      'Require the release checks', 'actions/setup-node', 'Verify staging serves', 'Require the protected migration',
      'Confirm the Render service', 'Deploy production', 'Verify production serves'].map(index);
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(workflow).toContain('git -C candidate rev-parse HEAD');
  });

  it('runs release tooling only from the trusted workflow commit, never from the commit being promoted', () => {
    const control = workflow.slice(workflow.indexOf('- name: Check out the trusted release tooling'), workflow.indexOf('- name: Check out the exact release commit'));
    expect(control).toContain('ref: ${{ github.sha }}');
    expect(control).toContain('path: control');
    const candidate = workflow.slice(workflow.indexOf('- name: Check out the exact release commit'), workflow.indexOf('- name: Confirm the commit is on main'));
    expect(candidate).toContain('ref: ${{ inputs.sha }}');
    expect(candidate).toContain('path: candidate');
    // every script invocation goes through control/; the candidate is only ever inspected with git
    expect(workflow).not.toMatch(/(?<!control\/)scripts\/(?:verify-release\.mjs|render-deploy\.sh)/);
    expect(workflow).toContain('node control/scripts/verify-release.mjs --environment staging');
    expect(workflow).toContain('control/scripts/render-deploy.sh');
    expect(workflow).not.toMatch(/\bcd candidate\b|working-directory: candidate/);
    expect(workflow).toContain('[ "${GITHUB_REF}" = "refs/heads/main" ]');
  });

  it('has a dry run that does every check and the Render identity check but never deploys', () => {
    expect(workflow).toContain('dry_run:');
    const deploy = workflow.slice(workflow.indexOf('- name: Deploy production'), workflow.indexOf('- name: Verify production'));
    const verify = workflow.slice(workflow.indexOf('- name: Verify production'), workflow.indexOf('- name: Dry run finished'));
    expect(deploy).toContain("if: ${{ env.DRY_RUN != 'true' }}");
    expect(verify).toContain("if: ${{ env.DRY_RUN != 'true' }}");
    const identity = workflow.slice(workflow.indexOf('- name: Confirm the Render service'), workflow.indexOf('- name: Deploy production'));
    expect(identity).not.toContain('DRY_RUN');  // the identity check always runs
    expect(identity).toContain('control/scripts/verify-render-production-targets.mjs');
    expect(identity).toContain('RENDER_PRODUCTION_WORKER_SERVICE_ID');
  });

  it('verifies both destinations before deploying the worker then web at the same SHA',()=>{
    const identity=workflow.slice(workflow.indexOf('- name: Confirm the Render service'),workflow.indexOf('- name: Deploy production'));
    expect(identity).toContain('verify-render-production-targets.mjs');
    const deploy=workflow.slice(workflow.indexOf('- name: Deploy production'),workflow.indexOf('- name: Verify production'));
    expect(deploy).toContain('set -euo pipefail');
    const calls=[...deploy.matchAll(/control\/scripts\/render-deploy\.sh "\$\{([^}]+)\}" "\$\{SHA\}"/g)].map(match=>match[1]);
    expect(calls).toEqual(['RENDER_PRODUCTION_WORKER_SERVICE_ID','RENDER_PRODUCTION_SERVICE_ID']);
  });

  it('asks the CI and restore-drill workflows directly and refuses unknown or changed migrations without confirmation', () => {
    expect(workflow).toContain('for workflow in ci.yml selfhost.yml');
    expect(workflow).toContain('actions/workflows/${workflow}/runs?head_sha=${SHA}&per_page=100');
    expect(workflow).not.toContain('&status=success');
    expect(workflow).toContain('.head_sha == $sha and .path == $path');
    expect(workflow).toContain('.status == "completed" and .conclusion == "success"');
    expect(workflow).toContain('changed=unknown');
    expect(workflow).toContain('[ "${changed}" != "false" ] && [ "${MIGRATIONS_APPLIED}" != "true" ]');
    expect(workflow).not.toMatch(/migrate-production|apply-migrations/);
  });
});

async function appServer(handler: (path: string) => [number, unknown]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const [status, body] = handler(req.url ?? '');
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, url: `http://127.0.0.1:${address.port}` };
}
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
const healthy = (sha: string, environment = 'production') => (path: string): [number, unknown] =>
  path === '/api/health/version' ? [200, { appId: 'flockletter', surface: 'app', environment, buildSha: sha }]
    : path === '/readyz' ? [200, { ready: true, gaps: [], sendingEnabled: false }] : [404, null];

describe('release verification script', () => {
  it('passes only when commit, environment and readiness all match', async () => {
    const ok = await appServer(healthy(SHA));
    const wrongSha = await appServer(healthy('d'.repeat(40)));
    const wrongEnv = await appServer(healthy(SHA, 'staging'));
    const noVersion = await appServer(path => path === '/readyz' ? [200, { ready: true, gaps: [] }] : [404, null]);
    const notReady = await appServer(path => path === '/readyz' ? [503, { ready: false, gaps: ['database_unavailable'] }] : healthy(SHA)(path));
    try {
      const run = (urls: string[]) => checkOnce({ urls, environment: 'production', expectedSha: SHA });
      expect(await run([ok.url])).toEqual([]);
      expect((await run([wrongSha.url]))[0]).toMatch(/serving dddddddddddd, expected cccccccccccc/);
      expect((await run([wrongEnv.url]))[0]).toMatch(/identity is flockletter\/staging/);
      expect((await run([noVersion.url]))[0]).toMatch(/version is not available/);
      expect((await run([notReady.url])).join()).toMatch(/not ready \(HTTP 503; database_unavailable\)/);
      expect(await run([ok.url, wrongSha.url])).toHaveLength(1); // every address must match
    } finally { await Promise.all([ok, wrongSha, wrongEnv, noVersion, notReady].map(s => close(s.server))); }
  });

  it('retries until the deadline and rejects malformed arguments', async () => {
    let calls = 0;
    const fetchImpl = async (url: URL) => {
      const path = url.pathname;
      if (path === '/api/health/version') calls += 1;
      const body = calls >= 3 ? healthy(SHA)(path) : ([503, null] as [number, unknown]);
      return { status: body[0], json: async () => body[1] } as Response;
    };
    let clock = 0;
    const result = await verifyRelease({ urls: ['https://x'], environment: 'production', expectedSha: SHA, timeoutMs: 100000,
      intervalMs: 5000, fetchImpl, now: () => clock, sleep: async (ms: number) => { clock += ms; } });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    const never = await verifyRelease({ urls: ['https://x'], environment: 'production', expectedSha: SHA, timeoutMs: 10000,
      intervalMs: 5000, fetchImpl: async () => ({ status: 503, json: async () => null }) as Response, now: () => clock, sleep: async (ms: number) => { clock += ms; } });
    expect(never.ok).toBe(false);
    await expect(verifyRelease({ urls: [], environment: 'production', expectedSha: SHA })).rejects.toThrow(/--url/);
    await expect(verifyRelease({ urls: ['https://x'], environment: 'dev', expectedSha: SHA })).rejects.toThrow(/staging or production/);
    await expect(verifyRelease({ urls: ['https://x'], environment: 'production', expectedSha: 'main' })).rejects.toThrow(/full lowercase SHA/);
  });
});
