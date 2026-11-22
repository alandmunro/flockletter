import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/deploy-staging.yml', import.meta.url), 'utf8');
function steps() { return [...workflow.matchAll(/^ {6}- (?:name: (.+)|uses: (.+))$/gm)].map(m => m[1] ?? m[2] ?? ''); }
const index = (name: string) => steps().findIndex(s => s.startsWith(name));
const section = (from: string, to: string) => workflow.slice(workflow.indexOf('- name: ' + from), workflow.indexOf('- name: ' + to));

describe('staging deploy workflow', () => {
  it('is dispatch-only, least-privilege and serialized with production promotion', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    const triggers = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\nconcurrency:'));
    expect(triggers).not.toMatch(/pull_request|push|schedule|workflow_run/);
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n {2}actions: read\n/);
    expect(workflow).toContain('group: flockletter-production');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain("run-name: Deploy to staging · ${{ inputs.request_id || 'manual' }}");
  });

  it('pins actions and gives the Render key only to the identity check and the deploy', () => {
    for (const line of workflow.split('\n').filter(l => /uses:/.test(l))) expect(line).toMatch(/@[0-9a-f]{40} # v\d+/);
    expect(workflow.match(/secrets\./g)).toHaveLength(2);
    expect(section('Confirm the Render service', 'Deploy staging')).not.toMatch(/-X POST|render-deploy/);
    expect(section('Deploy staging', 'Verify staging')).toContain('control/scripts/render-deploy.sh "${RENDER_STAGING_SERVICE_ID}" "${SHA}"');
  });

  it('checks the commit, its release checks and the migration gate before deploying, then verifies staging', () => {
    const order = ['Validate release inputs', 'Check out the trusted release tooling', 'Check out the exact release commit',
      'Confirm the commit is on main', 'Require the release checks', 'actions/setup-node', 'Read the current staging commit',
      'Require the protected migration', 'Confirm the Render service', 'Deploy staging', 'Verify staging serves'].map(index);
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(workflow).toContain('[ "${GITHUB_REF}" = "refs/heads/main" ]');
    expect(workflow).toContain('for workflow in ci.yml selfhost.yml; do');
    expect(section('Require the protected migration', 'Confirm the Render service')).toContain('[ "${changed}" != "false" ] && [ "${MIGRATIONS_APPLIED}" != "true" ]');
    expect(workflow).toContain('node control/scripts/verify-release.mjs --environment staging --url "${STAGING_URL}" --expected-sha "${SHA}"');
  });

  it('runs tooling only from the trusted workflow commit', () => {
    expect(section('Check out the trusted release tooling', 'Check out the exact release commit')).toContain('ref: ${{ github.sha }}');
    expect(workflow).not.toMatch(/(?<!control\/)scripts\/(?:verify-release\.mjs|render-deploy\.sh|verify-render-staging-target\.mjs)/);
    expect(workflow).not.toMatch(/\bcd candidate\b|working-directory: candidate/);
    expect(section('Confirm the Render service', 'Deploy staging')).toContain('control/scripts/verify-render-staging-target.mjs');
  });
});
