import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DirectoryMember } from '../src/shared/team.js';
import { TeamRoster, brandLabel } from '../src/client/TeamRoster.js';
import { MemberAccess } from '../src/client/Team.js';

const brands = Array.from({ length: 6 }, (_, i) => ({
  id: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
  name: i <= 1 ? 'Alpine' : 'Brand ' + i,
}));
const owner: DirectoryMember = {
  userId: 'user_owneridentifier123456',
  name: 'Owner',
  membership: 'owner',
  permission: 'viewer',
  brandIds: [brands[0]!.id],
};
const member: DirectoryMember = {
  userId: 'user_memberidentifier654321',
  name: 'Morgan',
  membership: 'member',
  permission: 'editor',
  brandIds: [brands[1]!.id],
};
const roster = (rows: DirectoryMember[]) =>
  renderToStaticMarkup(
    createElement(TeamRoster, { members: rows, brands, disabled: false, onManage: vi.fn() }),
  );
const form = (person: DirectoryMember, overLimit = false) =>
  renderToStaticMarkup(
    createElement(MemberAccess, { member: person, brands, overLimit, change: vi.fn(), close: vi.fn() }),
  );

describe('workspace team UI', () => {
  it('shows authoritative owner access, scoped names and distinct identities without exposing whole account IDs', () => {
    const markup = roster([
      owner,
      member,
      { ...member, userId: 'user_second789012', brandIds: [], permission: null },
    ]);
    expect(markup).toContain('<table>');
    expect(markup).toContain('scope="row"');
    expect(markup).toContain('Team roster');
    expect(markup).toContain('Workspace owner');
    expect(markup).toContain('All brands');
    expect(markup).toContain('No brand access');
    expect(markup.match(/Manage access/g)).toHaveLength(2);
    expect(markup).toContain('Morgan (account ending 654321)');
    expect(markup).toContain('Morgan (account ending 789012)');
    expect(markup).toContain(brandLabel(brands[1]!, brands));
    expect(markup).not.toContain(member.userId);
    expect(markup).not.toContain(owner.userId);
    expect(roster([])).toContain('No members on this page');
  });
  it('renders explicit role and brand selection and keeps the fifth-brand cap visible to assistive technology', () => {
    const markup = form({ ...member, brandIds: brands.slice(0, 5).map((b) => b.id) });
    expect(markup).toContain('Flockletter role');
    expect(markup).toContain('Brands for Morgan');
    expect(markup.match(/type="checkbox"/g)).toHaveLength(6);
    expect(markup.match(/checked=""/g)).toHaveLength(5);
    expect(markup).toMatch(/type="checkbox" disabled=""/);
    expect(markup).not.toContain(member.userId);
    expect(markup).toContain('Remove brand access');
    expect(markup).not.toContain('Confirm removal');
    expect(form({ ...member, permission: null, brandIds: [] })).not.toContain('Remove brand access');
  });
  it('keeps allow/revoke distinct over the seat limit and exposes no mutable owner grant', () => {
    const locked = form(member, true);
    expect(locked).toContain('<fieldset disabled="">');
    expect(locked).toContain('Remove brand access');
    const ownerView = form(owner);
    expect(ownerView).toContain('Workspace owners');
    expect(ownerView).not.toContain('<button');
  });
});
