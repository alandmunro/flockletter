import { createClerkClient } from '@clerk/backend';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import { pendingClerkInvitations } from '../src/server/auth.js';

describe('Clerk pending invitation transport', () => {
  it('requests one filtered organization page and discards foreign rows, tokens and metadata', async () => {
    const workspace = 'org_fixture';
    const invitation = {
      object: 'organization_invitation',
      id: 'orginv_fixture',
      email_address: 'fixture@example.test',
      organization_id: workspace,
      role: 'org:member',
      role_name: 'Member',
      status: 'pending',
      created_at: 1700000000000,
      updated_at: 1700000000000,
      expires_at: 1800000000000,
      url: 'https://example.test/private-acceptance-link',
      public_metadata: { privateValue: 'excluded' },
      private_metadata: { providerToken: 'excluded' },
    };
    const requests: { method: string; url: URL }[] = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method!, url: new URL(req.url!, 'http://127.0.0.1') });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [invitation], total_count: 26 }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('Missing test port.');
      const clerk = createClerkClient({
        apiUrl: 'http://127.0.0.1:' + address.port,
        secretKey: 'sk_test_fixture',
      });
      const read = () => pendingClerkInvitations(clerk.organizations, workspace, 25, 25);
      const result = await read();
      expect(result).toEqual({
        total: 26,
        invitations: [
          {
            id: invitation.id,
            email: invitation.email_address,
            expiresAt: new Date(invitation.expires_at).toISOString(),
          },
        ],
      });
      expect(requests[0]?.method).toBe('GET');
      expect(requests[0]?.url.pathname).toBe('/v1/organizations/' + workspace + '/invitations');
      expect(requests[0]?.url.searchParams.get('limit')).toBe('25');
      expect(requests[0]?.url.searchParams.get('offset')).toBe('25');
      expect(requests[0]?.url.searchParams.getAll('status')).toEqual(['pending']);
      invitation.organization_id = 'org_foreign';
      await expect(read()).rejects.toThrow('Invalid invitation');
      invitation.organization_id = workspace;
      invitation.status = 'revoked';
      await expect(read()).rejects.toThrow('Invalid invitation');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
