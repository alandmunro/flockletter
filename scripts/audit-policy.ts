// Dependency audit policy. Production dependencies must have no advisory at or
// above the threshold. Development-only advisories may be accepted temporarily
// through scripts/audit-exceptions.json, each with a reason and an expiry date.

export const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 } as const;
export type Severity = keyof typeof severityRank;

export interface AuditException {
  advisory: string;
  package: string;
  scope: 'development';
  reason: string;
  accepted: string;
  expires: string;
}

export interface Advisory {
  id: string;
  package: string;
  severity: Severity;
  title: string;
}

interface AuditVia {
  name?: string;
  title?: string;
  url?: string;
  severity?: string;
}

interface AuditReport {
  vulnerabilities?: Record<string, { via?: Array<string | AuditVia> }>;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && Object.hasOwn(severityRank, value);
}

/** Collects the distinct advisories in an `npm audit --json` report. */
export function advisoriesFrom(report: AuditReport): Advisory[] {
  const found = new Map<string, Advisory>();
  for (const entry of Object.values(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via === 'string' || !via.url || !via.name || !isSeverity(via.severity)) continue;
      const id = via.url.split('/').at(-1) ?? via.url;
      const key = `${id}:${via.name}`;
      if (!found.has(key)) found.set(key, { id, package: via.name, severity: via.severity, title: via.title ?? '' });
    }
  }
  return [...found.values()];
}

export function validateExceptions(raw: unknown): AuditException[] {
  const list = (raw as { exceptions?: unknown })?.exceptions;
  if (!Array.isArray(list)) throw new Error('audit exceptions must contain an "exceptions" array');
  return list.map((item, index) => {
    const e = item as Partial<AuditException>;
    const where = `audit exception ${index + 1}`;
    if (typeof e.advisory !== 'string' || !e.advisory.startsWith('GHSA-')) throw new Error(`${where}: advisory must be a GHSA id`);
    if (typeof e.package !== 'string' || !e.package) throw new Error(`${where}: package is required`);
    if (e.scope !== 'development') throw new Error(`${where}: only development-only exceptions are allowed`);
    if (typeof e.reason !== 'string' || e.reason.length < 40) throw new Error(`${where}: a specific reason is required`);
    if (typeof e.accepted !== 'string' || !datePattern.test(e.accepted)) throw new Error(`${where}: accepted must be YYYY-MM-DD`);
    if (typeof e.expires !== 'string' || !datePattern.test(e.expires)) throw new Error(`${where}: expires must be YYYY-MM-DD`);
    if (e.expires <= e.accepted) throw new Error(`${where}: expires must be after accepted`);
    return e as AuditException;
  });
}

export interface AuditVerdict {
  errors: string[];
  warnings: string[];
}

export function evaluateAudit(input: {
  production: AuditReport;
  full: AuditReport;
  exceptions: AuditException[];
  today: string;
  threshold?: Severity;
}): AuditVerdict {
  const threshold = severityRank[input.threshold ?? 'moderate'];
  const errors: string[] = [];
  const warnings: string[] = [];
  const atOrAbove = (a: Advisory) => severityRank[a.severity] >= threshold;

  const productionFindings = advisoriesFrom(input.production).filter(atOrAbove);
  for (const a of productionFindings) {
    errors.push(`production dependency ${a.package} has ${a.severity} advisory ${a.id}; production advisories cannot be excepted`);
  }
  const productionKeys = new Set(productionFindings.map((a) => `${a.id}:${a.package}`));

  const used = new Set<AuditException>();
  for (const a of advisoriesFrom(input.full).filter(atOrAbove)) {
    if (productionKeys.has(`${a.id}:${a.package}`)) continue;
    const match = input.exceptions.find((e) => e.advisory === a.id && e.package === a.package);
    if (!match) {
      errors.push(`${a.package} has ${a.severity} advisory ${a.id} (${a.title}) with no exception`);
    } else if (match.expires < input.today) {
      errors.push(`exception for ${a.id} in ${a.package} expired on ${match.expires}; upgrade or review it again`);
      used.add(match);
    } else {
      warnings.push(`accepted until ${match.expires}: ${a.package} ${a.severity} advisory ${a.id}`);
      used.add(match);
    }
  }
  for (const e of input.exceptions) {
    if (!used.has(e)) warnings.push(`exception for ${e.advisory} in ${e.package} is no longer needed; remove it`);
  }
  return { errors, warnings };
}
