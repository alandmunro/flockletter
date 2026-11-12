import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const capturedProps=vi.hoisted(()=>({values:{} as Record<string,Record<string,unknown>>}));
const authState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: false,
  orgId: undefined as string | undefined,
  sessionId: 'session_fixture',
}));

const clerkState = vi.hoisted(() => ({
  session: { id: 'session_fixture' } as { id: string },
  organization: undefined as { id: string } | undefined,
}));

vi.mock('@clerk/react', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
  SignIn: (props: Record<string, unknown>) => {capturedProps.values['signin']=props;return createElement('div', { 'data-signin': '' });},
  SignUp: (props: Record<string, unknown>) => {capturedProps.values['signup']=props;return createElement('div', { 'data-signup': '' });},
  UserButton: () => createElement('span', null, 'user'),
  OrganizationSwitcher: (props: Record<string, unknown>) => {capturedProps.values['org-switch']=props;return createElement('div', { 'data-org-switch': '' });},
  CreateOrganization: (props: Record<string, unknown>) => {capturedProps.values['create-org']=props;return createElement('div', { 'data-create-org': '' });},
  useAuth: () => authState,
  useClerk: () => clerkState,
  useReverification: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('../src/client/App.js', () => ({
  Header: (props: { account?: React.ReactNode }) => createElement('header', null, props.account),
  Portal: (props: Record<string, unknown>) => createElement('div', { 'data-portal': JSON.stringify(props) }),
}));

vi.mock('../src/client/OperatorPortal.js', () => ({
  OperatorPortal: (props: Record<string, unknown>) => createElement('div', { 'data-operator': JSON.stringify(props) }),
}));

vi.mock('../src/client/SetupStatus.js', () => ({
  SetupStatus: (props: Record<string, unknown>) => createElement('div', { 'data-setup': JSON.stringify(props) }),
}));

import HostedPortal from '../src/client/Hosted.js';

function render(pathname: string, search = '') {
  vi.stubGlobal('window', { location: { pathname, search } });
  const html = renderToStaticMarkup(
    createElement(HostedPortal, { publishableKey: 'pk_test_fixture', environment: 'staging', setupGaps: [] }),
  );
  vi.unstubAllGlobals();
  return html;
}

describe('Hosted.tsx redirect props', () => {
  beforeEach(() => {
    capturedProps.values={};
    authState.isLoaded = true;
    authState.isSignedIn = false;
    authState.orgId = undefined;
    clerkState.session = { id: 'session_fixture' };
    clerkState.organization = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unsigned /sign-up?plan=growth keeps /subscription?plan=growth in SignUp forceRedirectUrl and signInUrl', () => {
    const html = render('/sign-up', '?plan=growth');
    expect(html).toContain('data-signup="');
    const signup = capturedProps.values.signup!;
    expect(signup.forceRedirectUrl).toBe('/subscription?plan=growth');
    expect(signup.signInUrl).toBe('/subscription?plan=growth');
  });

  it('unsigned /subscription?plan=pro keeps same forceRedirectUrl and SignIn signUpUrl /sign-up?plan=pro', () => {
    const html = render('/subscription', '?plan=pro');
    expect(html).toContain('data-signin="');
    const signin = capturedProps.values.signin!;
    expect(signin.forceRedirectUrl).toBe('/subscription?plan=pro');
    expect(signin.signUpUrl).toBe('/sign-up?plan=pro');
  });

  it('signed-in with no org uses CreateOrganization afterCreateOrganizationUrl preserving tier', () => {
    authState.isSignedIn = true;
    const html = render('/subscription', '?plan=growth');
    expect(html).toContain('data-create-org="');
    const createOrg = capturedProps.values['create-org']!;
    expect(createOrg.afterCreateOrganizationUrl).toBe('/subscription?plan=growth');
  });

  it('OrganizationSwitcher returns to the same subscription route after selection/creation', () => {
    authState.isSignedIn = true;
    const html = render('/subscription', '?plan=pro');
    expect(html).toContain('data-org-switch="');
    const orgSwitch = capturedProps.values['org-switch']!;
    expect(orgSwitch.afterSelectOrganizationUrl).toBe('/subscription?plan=pro');
    expect(orgSwitch.afterCreateOrganizationUrl).toBe('/subscription?plan=pro');
  });

  it('unknown redirect/plan hints never appear in returned props', () => {
    const html = render('/unknown-path', '?plan=invalid&billing=fake&next=https://untrusted.example');
    expect(html).toContain('data-signin="');
    expect(capturedProps.values.signin!.forceRedirectUrl).toBe('/');
    expect(capturedProps.values.signin!.signUpUrl).toBe('/sign-up');
    expect(JSON.stringify(capturedProps.values)).not.toMatch(/invalid|fake|untrusted/);
  });
});
