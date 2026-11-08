import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { currentMfa } from '../src/server/platform/auth.js';
import { platformCommands } from '../src/shared/platform.js';

describe('platform auth and commands', () => {
  it('currentMfa validates both-factor ages', () => {
    const cases: [unknown, boolean, boolean][] = [
      [[1, 2], true, true],
      [[0.5, 4], true, true],
      [[1, -1], true, false],
      [[1, 5.1], true, false],
      [[0,5],true,false],
      [[NaN,0],true,false],
      [[Infinity,0],true,false],
      [null, true, false],
      [[1], true, false],
      [[1, 2], false, false],
    ];
    for (const [ages, enabled, expected] of cases) {
      expect(currentMfa(ages, enabled)).toBe(expected);
    }
  });

  it('platform.openCase schema accepts valid and rejects extra fields', () => {
    const baseline = {
      operationKey: crypto.randomUUID(),
      workspaceId: 'org_x',
      kind: 'support' as const,
      resourceId: null,
      reason: 'this is a valid reason with at least twelve characters',
    };
    expect(platformCommands['platform.openCase'].schema.safeParse(baseline).success).toBe(true);
    const withExtra = { ...baseline, extraField: 'nope' };
    expect(platformCommands['platform.openCase'].schema.safeParse(withExtra).success).toBe(false);
  });

  it('platform.openCase rejects invalid workspaceId and non-UUID operationKey', () => {
    const badWorkspace = {
      ...{
        workspaceId: 'bad-org-id',
        kind: 'support' as const,
        resourceId: null,
        reason: 'this is a valid reason with at least twelve characters',
      },
      operationKey: crypto.randomUUID(),
    };
    expect(platformCommands['platform.openCase'].schema.safeParse(badWorkspace).success).toBe(false);

    const badOperationKey = {
      operationKey: 'not-a-uuid',
      workspaceId: 'org_x',
      kind: 'support' as const,
      resourceId: null,
      reason: 'this is a valid reason with at least twelve characters',
    };
    expect(platformCommands['platform.openCase'].schema.safeParse(badOperationKey).success).toBe(false);
  });
});

