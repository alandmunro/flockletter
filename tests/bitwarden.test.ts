import { describe, expect, it } from 'vitest';
import { bitwardenProject, parseAccessToken, readProjectSecrets } from '../src/server/secrets/bitwarden.js';
import { fakeBitwarden } from './helpers/bitwarden-fake.js';

describe('Bitwarden Secrets Manager reader (FL-SMS-014)', () => {
  it('decrypts only the named project’s keys and ignores the other environment', async () => {
    const bw = fakeBitwarden();
    const staging = await readProjectSecrets({ accessToken: bw.token, projectName: 'flockletter-staging', keys: ['FLOCKLETTER_TWILIO_ACCOUNT_SID', 'FLOCKLETTER_TWILIO_AUTH_TOKEN'], fetch: bw.fetcher });
    expect([...staging.entries()]).toEqual([['FLOCKLETTER_TWILIO_ACCOUNT_SID', 'AC-staging-value']]);
    const production = await readProjectSecrets({ accessToken: bw.token, projectName: 'flockletter-production', keys: ['FLOCKLETTER_TWILIO_AUTH_TOKEN'], fetch: bw.fetcher });
    expect(production.get('FLOCKLETTER_TWILIO_AUTH_TOKEN')).toBe('production-only-value');
  });
  it('refuses an invisible project, a malformed token and a tampered value without echoing secrets', async () => {
    const bw = fakeBitwarden();
    await expect(readProjectSecrets({ accessToken: bw.token, projectName: 'openclaw', keys: [], fetch: bw.fetcher })).rejects.toThrow('cannot read the openclaw project');
    expect(() => parseAccessToken('0.not-a-token')).toThrow('malformed');
    try { parseAccessToken('0.x.supersecret:abc'); } catch (e) { expect((e as Error).message).not.toContain('supersecret'); }
    expect(() => bitwardenProject('staging', 'flockletter-production')).toThrow();
    expect(() => bitwardenProject('production', 'flockletter-staging')).toThrow();
    expect(bitwardenProject('staging', 'flockletter-staging')).toBe('flockletter-staging');
  });
});
