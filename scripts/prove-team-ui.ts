import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startDatabase } from './database-fixture.js';
import { recordAccess } from './complimentary-access.js';
import { createApp } from '../src/server/app.js';
import { Authenticator, localIdentity, type IdentityProvider } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import type { ClerkTeam } from '../src/server/team.js';
import type { IssuedInvitation } from '../src/server/team-invitation-provider.js';
import { emptyContent, type Campaign, type CommandName, type Workspace } from '../src/shared/contracts.js';

const workspace = 'org_local_sample',
  owner = 'local_owner';
const memberId = 'user_team000001',
  memberName = 'Casey Field';
const viewer = { userId: 'user_team000002', token: randomUUID() };
const editor = { userId: 'user_team000003', token: randomUUID() };
type FixtureMember = typeof viewer;
const directory = [
  { userId: owner, name: 'Fixture Owner', membership: 'owner' as const },
  ...Array.from({ length: 26 }, (_, i) => ({
    userId: i === 0 ? memberId : 'user_team' + String(i + 1).padStart(6, '0'),
    name: i === 0 ? memberName : 'Fixture member ' + (i + 1),
    membership: 'member' as const,
  })),
];
const pilotEmail='browser-invite@example.test';
const simulatedInvitations:IssuedInvitation[]=Array.from({length:26},(_,i)=>({
  id:'orginv_fixture_'+i,workspace,role:'org:member',email:'invited'+i+'@example.test',reference:null,state:'pending',
}));
const clerk: ClerkTeam = {
  async members(w, offset, limit) {
    return w === workspace
      ? { total: directory.length, members: directory.slice(offset, offset + limit) }
      : { total: 0, members: [] };
  },
  async membership(user, w) {
    return w === workspace ? (directory.find((member) => member.userId === user)?.membership ?? null) : null;
  },
  async invitations(w, offset, limit) {
    assert.equal(w, workspace);
    const pending=simulatedInvitations.map(({id,email})=>({id,email,expiresAt:'2028-12-01T00:00:00.000Z'}));
    return {total:pending.length, invitations:pending.slice(offset,offset+limit)};
  },
  invitePilot:{
    binding:{workspace,recipients:[pilotEmail]},
    async inspect(){return {maximum:0,members:directory.map(({userId})=>userId+'@example.test'),invitations:[...simulatedInvitations]};},
    async lookup(){return [...simulatedInvitations];},
    async create(request){
      assert.equal(request.workspace,workspace); assert.equal(request.email,pilotEmail);assert.equal(request.issuer,owner);
      const row:IssuedInvitation={id:'orginv_browser',workspace,role:'org:member',email:request.email,
        reference:request.reference,state:'pending'};
      simulatedInvitations.push(row);return row;
    },
  },
};
function fixtureIdentity(): IdentityProvider {
  const original = localIdentity();
  return {
    ...original,
    team: clerk,
    async session(request) {
      const bearer = request.get('authorization');
      const member = [viewer, editor].find((m) => bearer === 'Bearer ' + m.token);
      if (!member) return original.session(request);
      assert.ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''));
      return { userId: member.userId, workspaceId: workspace };
    },
  };
}
const fixture = await startDatabase();
async function screenshot(page: Page, name: string) {
  const target = process.env.FLOCKLETTER_TEAM_SCREENSHOTS;
  if (!target) return;
  await mkdir(target, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(target, name + '.png') });
}
const db = new Database(fixture.url),
  operator = new Database(fixture.adminUrl);
const server = createServer();
let browser: Browser | undefined;
const actor: Actor = {
  workspaceId: workspace,
  userId: owner,
  actorId: 'user:' + owner,
  owner: true,
  kind: 'session',
  scopes: ['read'],
  brandIds: null,
};
const grantPlan = (plan: 'pro' | 'starter') =>
  recordAccess(operator, workspace, {
    workspaceId: workspace,
    plan,
    operator: 'Synthetic fixture',
    reason: 'Exercise team seat limits',
    operationKey: randomUUID(),
  });
async function transient(page: Page, command: 'team.grant' | 'team.revoke') {
  const keys: string[] = [];
  await page.route('**/api/v1/commands/' + command, async (route) => {
    keys.push(route.request().postDataJSON().operationKey);
    const response = await route.fetch();
    assert.equal(
      response.status(),
      200,
      'The canonical team mutation must commit before simulating a lost response.',
    );
    if (keys.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  return keys;
}
async function memberPage(browser: Browser, origin: string, member: FixtureMember) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.route(origin + '/api/v1/**', (route) =>
    route.continue({ headers: { ...route.request().headers(), authorization: 'Bearer ' + member.token } }),
  );
  await page.goto(origin);
  return page;
}
async function assertMemberNavigation(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  assert.deepEqual(await nav.getByRole('button').allTextContents(), ['Campaigns', 'Image library']);
}
async function denied(
  page: Page,
  origin: string,
  member: FixtureMember,
  command: CommandName,
  data: object,
  status: number,
  code: string,
) {
  const response = await page.request.post(origin + '/api/v1/commands/' + command, {
    headers: { authorization: 'Bearer ' + member.token },
    data,
  });
  assert.equal(response.status(), status);
  assert.equal((await response.json()).error.code, code);
}
async function proveMemberAccess(
  browser: Browser,
  origin: string,
  service: CommandService,
  alpine: string,
  trail: string,
) {
  await grantPlan('pro');
  const seed = (brandId: string, title: string, body: string) =>
    service.execute(
      'campaign.create',
      {
        operationKey: randomUUID(),
        brandId,
        content: { ...emptyContent(), title, subject: title, body },
      },
      actor,
    ) as Promise<Campaign>;
  const alpineDraft = await seed(alpine, 'Alpine field letter', 'Snow has reached the alpine meadow.');
  const trailDraft = await seed(trail, 'Trail field letter', 'The trail crew welcomes new readers.');
  for (const [member, permission, brandId] of [
    [viewer, 'viewer', alpine],
    [editor, 'editor', trail],
  ] as const) {
    await service.execute(
      'team.grant',
      {
        operationKey: randomUUID(),
        userId: member.userId,
        permission,
        brandIds: [brandId],
      },
      actor,
    );
  }
  const viewerPage = await memberPage(browser, origin, viewer);
  await viewerPage.getByText('Viewer access · Alpine Notes', { exact: true }).waitFor();
  await assertMemberNavigation(viewerPage);
  await viewerPage.getByRole('button', { name: 'View ' + alpineDraft.content.title }).waitFor();
  assert.equal(await viewerPage.getByText(trailDraft.content.title, { exact: true }).count(), 0);
  assert.equal(await viewerPage.getByRole('button', { name: '+ New campaign', exact: true }).count(), 0);
  await viewerPage.getByRole('button', { name: 'Image library', exact: true }).click();
  await viewerPage.getByText('Original photos for Alpine Notes. Read-only image library.').waitFor();
  assert.equal(await viewerPage.locator('input[type=file]').count(), 0);
  await viewerPage.getByRole('button', { name: 'Campaigns', exact: true }).click();
  await viewerPage.getByRole('button', { name: 'View ' + alpineDraft.content.title }).click();
  await viewerPage
    .frameLocator('iframe[title="Read-only campaign preview"]')
    .getByText(alpineDraft.content.body, { exact: true })
    .waitFor();
  await viewerPage.getByText('Plain text', { exact: true }).click();
  assert.ok((await viewerPage.locator('pre').innerText()).includes(alpineDraft.content.body));
  assert.equal(await viewerPage.getByRole('button', { name: 'Save draft' }).count(), 0);
  await screenshot(viewerPage, 'member-viewer');
  await denied(viewerPage, origin, viewer, 'campaign.get', { id: trailDraft.id }, 404, 'not_found');
  await denied(
    viewerPage,
    origin,
    viewer,
    'campaign.update',
    {
      operationKey: randomUUID(),
      id: alpineDraft.id,
      expectedVersion: 1,
      content: alpineDraft.content,
    },
    403,
    'scope_required',
  );
  await denied(viewerPage, origin, viewer, 'team.list', { offset: 0 }, 403, 'owner_required');
  await denied(viewerPage, origin, viewer, 'team.invitations', { offset: 0 }, 403, 'owner_required');

  const editorPage = await memberPage(browser, origin, editor);
  await editorPage.getByText('Editor access · Trail Reports', { exact: true }).waitFor();
  await assertMemberNavigation(editorPage);
  await editorPage.getByRole('button', { name: 'Edit ' + trailDraft.content.title }).waitFor();
  assert.equal(await editorPage.getByText(alpineDraft.content.title, { exact: true }).count(), 0);
  await denied(editorPage, origin, editor, 'audience.list', { brandId: trail }, 403, 'owner_required');
  await denied(editorPage, origin, editor, 'connection.list', {}, 403, 'owner_required');
  await denied(editorPage, origin, editor, 'workspace.operations', {}, 403, 'owner_required');
  await denied(editorPage, origin, editor, 'campaign.get', { id: alpineDraft.id }, 404, 'not_found');
  await denied(
    editorPage,
    origin,
    editor,
    'campaign.create',
    {
      operationKey: randomUUID(),
      brandId: alpine,
      content: { ...emptyContent(), title: 'Outside grant' },
    },
    404,
    'not_found',
  );
  const created = editorPage.waitForResponse((r) => r.url() === origin + '/api/v1/commands/campaign.create');
  await editorPage.getByRole('button', { name: '+ New campaign' }).click();
  const response = await created;
  assert.equal(response.status(), 200);
  const { result: newDraft } = (await response.json()) as { result: Campaign };
  assert.equal(newDraft.brandId, trail);
  const title = 'Trail dispatch from the editor';
  await editorPage.getByLabel('Title', { exact: true }).fill(title);
  await editorPage.getByRole('button',{name:'Edit paragraph block',exact:true}).first().click();
  await editorPage.getByRole('textbox',{name:'Paragraph text',exact:true}).fill('Meet at the trailhead this Sunday.');
  await editorPage.getByRole('button', { name: 'Save draft' }).click();
  await editorPage.getByRole('status').filter({ hasText: 'Saved version 2.' }).waitFor();
  const savedDraft = () => service.execute('campaign.get', { id: newDraft.id }, actor) as Promise<Campaign>;
  const saved = await savedDraft();
  assert.deepEqual(
    [saved.brandId, saved.version, saved.content.title, saved.content.body],
    [trail, 2, title, 'Meet at the trailhead this Sunday.'],
  );
  await editorPage.getByRole('button', { name: 'Preview & check' }).click();
  await editorPage
    .frameLocator('iframe[title="Campaign email preview"]')
    .getByText(saved.content.body, { exact: true })
    .waitFor();
  assert.equal(await editorPage.getByText('Current brand audience', { exact: true }).count(), 0);
  await screenshot(editorPage, 'member-editor');

  await editorPage.getByRole('button',{name:'Edit paragraph block',exact:true}).first().click();
  await editorPage.getByRole('textbox',{name:'Paragraph text',exact:true}).fill('A stale edit must never be stored.');
  await service.execute('team.revoke', { userId: editor.userId, operationKey: randomUUID() }, actor);
  await editorPage.getByRole('button', { name: 'Save draft' }).click();
  await editorPage
    .getByRole('alert')
    .filter({ hasText: 'Ask a workspace owner to grant access to a brand.' })
    .waitFor();
  assert.deepEqual(await savedDraft(), saved);
  await editorPage.reload();
  await editorPage
    .getByRole('alert')
    .filter({ hasText: 'Ask a workspace owner to grant access to a brand.' })
    .waitFor();
  assert.equal(await editorPage.getByRole('navigation', { name: 'Main navigation' }).count(), 0);
  assert.equal(await editorPage.getByRole('textbox').count(), 0);
  await denied(editorPage, origin, editor, 'campaign.get', { id: newDraft.id }, 403, 'brand_access_required');
  assert.equal(await clerk.membership(editor.userId, workspace), 'member');
  await viewerPage.reload();
  await viewerPage.getByRole('button', { name: 'View ' + alpineDraft.content.title }).waitFor();
  await assertMemberNavigation(viewerPage);
  await viewerPage.context().close();
  await editorPage.context().close();
  console.info(
    'Independent viewer and editor sessions, scoped draft preview and save, foreign-brand denials and revocation passed.',
  );
}
try {
  await db.verifyBoundary();
  const identity = fixtureIdentity();
  const service = new CommandService(db, undefined, identity.isOwner, undefined, undefined, clerk);
  await service.execute(
    'workspace.initialize',
    { name: 'Synthetic team workspace', brandName: 'Alpine Notes', operationKey: randomUUID() },
    actor,
  );
  const w = (await service.execute('workspace.get', {}, actor)) as Workspace;
  const alpine = w.brands[0]!.id,
    trail = randomUUID();
  await db.tenant(workspace, (sql) =>
    sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      workspace,
      trail,
      'Trail Reports',
    ]),
  );
  await grantPlan('pro');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected a loopback port.');
  const origin = 'http://127.0.0.1:' + address.port;
  server.on(
    'request',
    createApp(
      loadConfig({
        APP_ENV: 'local',
        APP_ORIGIN: origin,
        LOCAL_TEST_IDENTITY: 'true',
        DATABASE_URL: fixture.url,
      }),
      service,
      new Authenticator(db, identity),
    ),
  );
  browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  await page.goto(origin);
  await page.route('**/api/v1/commands/team.invitations', (route) => route.abort('failed'));
  await button('Team').click();
  const roster = page.getByRole('table', { name: 'Team roster' });
  await roster.waitFor();
  assert.equal(await roster.locator('tbody tr').count(), 25);
  await page.getByText('Unlimited', { exact: true }).first().waitFor();
  await button('Retry invitation list').waitFor();
  await page.unroute('**/api/v1/commands/team.invitations');
  await button('Retry invitation list').click();
  await page.getByText('invited0@example.test', { exact: true }).waitFor();
  await button('Next invitations').click();
  await page.getByText('invited25@example.test', { exact: true }).waitFor();
  assert.equal(await page.getByText('invited0@example.test', {exact:true}).count(),0);
  await button('Previous invitations').click();
  await page.getByText('invited0@example.test', {exact:true}).waitFor();
  await page.getByLabel('Approved recipient').selectOption(pilotEmail);
  await button('Send member invitation').click();
  await page.getByText('Clerk recorded the invitation as pending.',{exact:true}).waitFor();
  await page.getByLabel('Approved recipient').selectOption(pilotEmail);
  assert.equal(await button('Send member invitation').count(),0);
  assert.equal(simulatedInvitations.filter((row)=>row.email===pilotEmail).length,1);
  await screenshot(page, 'team-desktop');
  assert.equal(
    await roster
      .getByRole('row', { name: /Fixture Owner/ })
      .getByRole('button')
      .count(),
    0,
  );
  await button('Next members').click();
  await page.getByText('Fixture member 26', { exact: true }).waitFor();
  assert.equal(await roster.locator('tbody tr').count(), 2);
  await button('Previous members').click();
  const manage = button('Manage access for ' + memberName);
  await manage.click();
  const heading = page.getByRole('heading', { name: 'Brand access for ' + memberName });
  assert.equal(await heading.evaluate((el) => el === document.activeElement), true);
  await button('Back to members').click();
  assert.equal(await manage.evaluate((el) => el === document.activeElement), true);
  await manage.click();
  assert.equal(await button('Save brand access').isEnabled(), false);
  await page.getByLabel('Flockletter role').selectOption('editor');
  await page.getByRole('checkbox', { name: 'Alpine Notes', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Trail Reports', exact: true }).check();
  await screenshot(page, 'team-access');
  const grants = await transient(page, 'team.grant');
  await button('Save brand access').click();
  await page.getByRole('alert').waitFor();
  await button('Save brand access').click();
  await page.getByText('Brand access saved for ' + memberName + '.', { exact: true }).waitFor();
  assert.equal(grants.length, 2);
  assert.equal(grants[0], grants[1]);
  const row = roster.getByRole('row', { name: new RegExp(memberName) });
  await row.getByText('Editor', { exact: true }).waitFor();
  const ids = await db.tenant(workspace, async (sql) =>
    (
      await sql.query('SELECT brand_id FROM team_grant_brands WHERE user_id=$1 ORDER BY brand_id', [memberId])
    ).rows.map((m) => m.brand_id),
  );
  assert.deepEqual(ids, [alpine, trail].sort());
  assert.ok(!page.url().includes(memberId));
  assert.ok(!(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).includes(memberId));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await screenshot(page, 'team-mobile');
  const width = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  assert.ok(
    width.document <= width.viewport,
    'Mobile team table fits its page: ' + width.document + ' / ' + width.viewport,
  );
  // An unknown grant may in fact have committed. A subsequent acknowledged revoke ends that attempt,
  // so deliberately granting the same input afterwards must use a fresh key.
  await page.unroute('**/api/v1/commands/team.grant');
  const interrupted = await transient(page, 'team.grant');
  await manage.click();
  await page.getByLabel('Flockletter role').selectOption('viewer');
  await button('Save brand access').click();
  await page.getByRole('alert').waitFor();
  await button('Remove brand access').click();
  await button('Confirm removal').click();
  await row.getByText('No brand access', { exact: true }).waitFor();
  await manage.click();
  await page.getByRole('checkbox', { name: 'Alpine Notes', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Trail Reports', exact: true }).check();
  await button('Save brand access').click();
  await row.getByText('Viewer', { exact: true }).waitFor();
  assert.equal(interrupted.length, 2);
  assert.notEqual(interrupted[0], interrupted[1]);
  await grantPlan('starter');
  await page.reload();
  await button('Team').click();
  await page.getByText(/This workspace exceeds its seat limit/).waitFor();
  await manage.click();
  assert.equal(await page.getByLabel('Flockletter role').isEnabled(), false);
  await button('Remove brand access').click();
  await button('Cancel removal').click();
  assert.equal(await button('Confirm removal').count(), 0);
  const removals = await transient(page, 'team.revoke');
  await button('Remove brand access').click();
  await button('Confirm removal').click();
  await page.getByRole('alert').waitFor();
  await button('Confirm removal').click();
  await page.getByText('Flockletter brand access removed for ' + memberName + '.', { exact: true }).waitFor();
  await row.getByText('No brand access', { exact: true }).waitFor();
  assert.equal(removals.length, 2);
  assert.equal(removals[0], removals[1]);
  assert.equal(await clerk.membership(memberId, workspace), 'member');
  assert.equal((await clerk.members(workspace, 0, 1)).total, 27);
  const audit = await db.tenant(
    workspace,
    async (sql) =>
      (
        await sql.query(
          "SELECT action,count(*)::int AS count FROM audit WHERE action LIKE 'team.%' GROUP BY action ORDER BY action",
        )
      ).rows,
  );
  assert.deepEqual(audit, [
    { action: 'team.grant', count: 3 },
    { action: 'team.invite.recorded', count: 1 },
    { action: 'team.invite.requested', count: 1 },
    { action: 'team.revoke', count: 2 },
  ]);
  console.info(
    'Team desktop/mobile, Clerk-fixture invitation paging, one synthetic invitation, grant/revoke retry, seat limits and audit passed.',
  );
  await proveMemberAccess(browser, origin, service, alpine, trail);
} finally {
  await browser?.close();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await operator.close();
  await db.close();
  await fixture.stop();
}
