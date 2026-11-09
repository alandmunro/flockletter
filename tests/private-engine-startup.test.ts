import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { Database } from '../src/server/db.js';
import { startLegacyMessenger } from '../src/server/private-engine-startup.js';
import { startPrivateMessenger } from '../src/server/campaign/private-messenger.js';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), access: vi.fn(),
}));
const db = new Database('postgresql://unused@127.0.0.1/flockletter_unused');
const checkOwner = async () => false;
beforeEach(() => vi.mocked(access).mockReset().mockResolvedValue(undefined));
afterAll(() => db.close());

it('keeps the staging messenger limited to its explicit workspace and brand', async () => {
  const workspace = 'org_rehearsal_fixture', brand = randomUUID();
  const env = { APP_ENV: 'staging', FLOCKLETTER_PRIVATE_ENGINE: 'embedded',
    FLOCKLETTER_CAPTURE_WORKSPACE: workspace, FLOCKLETTER_CAPTURE_BRAND: brand };
  const started = await startLegacyMessenger({ environment: 'staging' }, db, checkOwner, undefined, env);
  try {
    expect(started).toBeDefined();
    expect(started!.dispatcher.owns(workspace, brand)).toBe(true);
    expect(started!.dispatcher.owns('org_neighbor', brand)).toBe(false);
    expect(started!.dispatcher.owns(workspace, randomUUID())).toBe(false);
    expect(access).toHaveBeenCalledTimes(1);
  } finally { await started?.close(); }
});

it('preserves the staging scope guard and local environment guard', async () => {
  await expect(startLegacyMessenger({ environment: 'staging' }, db, checkOwner, undefined, {
    APP_ENV: 'staging', FLOCKLETTER_PRIVATE_ENGINE: 'embedded',
  })).rejects.toThrow('explicit staging workspace and brand');
  await expect(startLegacyMessenger({ environment: 'local' }, db, checkOwner, undefined, {
    APP_ENV: 'local', FLOCKLETTER_PRIVATE_ENGINE: 'embedded',
    FLOCKLETTER_CAPTURE_WORKSPACE: 'org_rehearsal_fixture', FLOCKLETTER_CAPTURE_BRAND: randomUUID(),
  })).rejects.toThrow('explicit staging workspace and brand');
  expect(access).not.toHaveBeenCalled();
});

it('does not relax the legacy helper itself for production', async () => {
  await expect(startPrivateMessenger(db, checkOwner, undefined, {
    APP_ENV: 'production', FLOCKLETTER_PRIVATE_ENGINE: 'embedded',
    FLOCKLETTER_CAPTURE_WORKSPACE: 'org_rehearsal_fixture', FLOCKLETTER_CAPTURE_BRAND: randomUUID(),
  })).rejects.toThrow('explicit staging workspace and brand');
  expect(access).not.toHaveBeenCalled();
});

it('skips the legacy helper in production without requiring staging scopes', async () => {
  await expect(startLegacyMessenger({ environment: 'production' }, db, checkOwner, undefined, {
    APP_ENV: 'production', FLOCKLETTER_PRIVATE_ENGINE: 'embedded',
  })).resolves.toBeUndefined();
  expect(access).not.toHaveBeenCalled();
});
