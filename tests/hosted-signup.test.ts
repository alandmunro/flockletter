import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const capturedProps=vi.hoisted(()=>({values:{} as Record<string,Record<string,unknown>>}));
const authState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: false,
  orgId: undefined as string | undefined,
  sessionId: 'session_fixture',
}));

const logoutAction = vi.hoisted(() => ({ current: null as null | (() => Promise<unknown>) }));
const clerkState = vi.hoisted(() => ({
  signOut: vi.fn(async (_options: { redirectUrl: string }) => {}),
  session: { id: 'session_fixture' } as { id: string },
  organization: undefined as { id: string } | undefined,
}));

vi.mock('@clerk/react', () => ({
  ClerkProvider: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => { capturedProps.values.provider = props; return createElement('div', null, children); },
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
  Portal: (props: { account?: ReactNode }) => createElement('div', { 'data-portal': '' }, props.account),
}));

vi.mock('../src/client/OperatorPortal.js', () => ({
  OperatorPortal: (props: { account?: ReactNode }) => createElement('div', { 'data-operator': '' }, props.account),
}));

vi.mock('../src/client/SetupStatus.js', () => ({
  SetupStatus: (props: Record<string, unknown>) => createElement('div', { 'data-setup': JSON.stringify(props) }),
}));

vi.mock('../src/client/LogoutButton.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/client/LogoutButton.js')>();
  return { LogoutButton: (props: { signOut: () => Promise<unknown> }) => {
    logoutAction.current = props.signOut;
    return createElement(actual.LogoutButton, props);
  } };
});

import HostedPortal from '../src/client/Hosted.js';

function render(pathname: string, search = '', setupGaps: string[] = []) {
  vi.stubGlobal('window', { location: { pathname, search } });
  const html = renderToStaticMarkup(
    createElement(HostedPortal, { publishableKey: 'pk_test_fixture', environment: 'staging', setupGaps }),
  );
  vi.unstubAllGlobals();
  return html;
}

describe('Hosted.tsx redirect props', () => {
  beforeEach(() => {
    capturedProps.values={};
    logoutAction.current = null;
    clerkState.signOut.mockClear();
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

  it.each([
    ['signed-out', true, false],
    ['loading', false, false],
  ])('%s state has no Log out button', (_state, loaded, signedIn) => {
    authState.isLoaded = loaded;
    authState.isSignedIn = signedIn;
    expect(render('/')).not.toContain('Log out');
    expect(logoutAction.current).toBeNull();
  });

  it.each([
    ['customer', '/', 'org_customer', []],
    ['workspace selection', '/', undefined, []],
    ['setup recovery', '/', 'org_customer', ['Database unavailable']],
    ['operator', '/operator', 'org_operator', []],
  ] as const)('%s shows one visible logout that revokes through Clerk and returns to root', async (_state, route, orgId, gaps) => {
    authState.isSignedIn = true;
    authState.orgId = orgId;
    clerkState.organization = orgId ? { id: orgId } : undefined;
    const html = render(route, '?next=https://untrusted.example', [...gaps]);
    expect(html.match(/>Log out<\/button>/g)).toHaveLength(1);
    expect(capturedProps.values.provider!.afterSignOutUrl).toBe('/');
    expect(logoutAction.current).not.toBeNull();
    await logoutAction.current!();
    expect(clerkState.signOut).toHaveBeenCalledExactlyOnceWith({ redirectUrl: '/' });
  });

});
