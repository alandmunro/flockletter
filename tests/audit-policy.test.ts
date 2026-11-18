import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { advisoriesFrom, evaluateAudit, validateExceptions, type AuditException } from '../scripts/audit-policy.js';

const advisory = (name: string, id: string, severity: string) => ({
  vulnerabilities: {
    [name]: { via: [{ name, title: `${name} issue`, url: `https://github.com/advisories/${id}`, severity }] },
  },
});
const clean = { vulnerabilities: {} };
const exception: AuditException = {
  advisory: 'GHSA-aaaa-bbbb-cccc',
  package: 'picomatch',
  scope: 'development',
  reason: 'Reached only through build tooling that matches fixed repository patterns.',
  accepted: '2026-11-17',
  expires: '2026-12-01',
};

describe('dependency audit policy', () => {
  it('collects distinct advisories and skips transitive name references', () => {
    const report = {
      vulnerabilities: {
        picomatch: { via: [{ name: 'picomatch', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }] },
        vite: { via: ['picomatch'] },
      },
    };
    expect(advisoriesFrom(report)).toEqual([{ id: 'GHSA-aaaa-bbbb-cccc', package: 'picomatch', severity: 'high', title: 't' }]);
  });

  it('passes a development-only advisory covered by a current exception', () => {
    const verdict = evaluateAudit({ production: clean, full: advisory('picomatch', exception.advisory, 'high'), exceptions: [exception], today: '2026-11-17' });
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings[0]).toContain('accepted until 2026-12-01');
  });

  it('fails an advisory without an exception', () => {
    const verdict = evaluateAudit({ production: clean, full: advisory('other', 'GHSA-dddd-eeee-ffff', 'moderate'), exceptions: [], today: '2026-11-17' });
    expect(verdict.errors).toHaveLength(1);
  });

  it('fails an expired exception', () => {
    const verdict = evaluateAudit({ production: clean, full: advisory('picomatch', exception.advisory, 'high'), exceptions: [exception], today: '2026-12-02' });
    expect(verdict.errors[0]).toContain('expired on 2026-12-01');
  });

  it('never excepts a production advisory', () => {
    const report = advisory('picomatch', exception.advisory, 'high');
    const verdict = evaluateAudit({ production: report, full: report, exceptions: [exception], today: '2026-11-17' });
    expect(verdict.errors).toHaveLength(1);
    expect(verdict.errors[0]).toContain('production advisories cannot be excepted');
  });

  it('ignores advisories below the threshold and flags unused exceptions', () => {
    const verdict = evaluateAudit({ production: clean, full: advisory('x', 'GHSA-1111-2222-3333', 'low'), exceptions: [exception], today: '2026-11-17' });
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings[0]).toContain('no longer needed');
  });

  it('rejects malformed or production-scoped exceptions', () => {
    expect(() => validateExceptions({ exceptions: [{ ...exception, scope: 'production' }] })).toThrow(/development-only/);
    expect(() => validateExceptions({ exceptions: [{ ...exception, expires: '2026-11-01' }] })).toThrow(/after accepted/);
    expect(() => validateExceptions({ exceptions: [{ ...exception, reason: 'short' }] })).toThrow(/reason/);
  });

  it('keeps the checked-in exceptions valid and short-lived', () => {
    const list = validateExceptions(JSON.parse(readFileSync(new URL('../scripts/audit-exceptions.json', import.meta.url), 'utf8')));
    for (const e of list) {
      const days = (Date.parse(e.expires) - Date.parse(e.accepted)) / 86_400_000;
      expect(days).toBeLessThanOrEqual(31);
    }
  });
});
