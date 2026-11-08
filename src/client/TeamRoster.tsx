import type { DirectoryMember } from '../shared/team.js';
import type { Brand } from '../shared/contracts.js';

export function brandLabel(brand: Brand, brands: Brand[]) {
  const duplicate = brands.some(
    (other) => other.id !== brand.id && other.name.toLowerCase() === brand.name.toLowerCase(),
  );
  return duplicate ? brand.name + ' (ID ending ' + brand.id.slice(-6) + ')' : brand.name;
}

export function accountSuffix(member: DirectoryMember) {
  return member.userId.replace(/^user_/, '').slice(-6);
}

export function TeamRoster({
  members,
  brands,
  onManage,
  disabled,
}: {
  members: DirectoryMember[];
  brands: Brand[];
  onManage: (member: DirectoryMember) => void;
  disabled: boolean;
}) {
  const brandNameById = new Map(brands.map((brand) => [brand.id, brandLabel(brand, brands)] as const));

  return (
    <div className="team-table-scroll">
      <table>
        <caption className="sr-only">Team roster</caption>
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col">Access</th>
            <th scope="col">Brands</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {members.length === 0 ? (
            <tr>
              <td colSpan={4}>No members on this page</td>
            </tr>
          ) : (
            members.map((member) => {
              const isOwner = member.membership === 'owner';

              const accessLabel = isOwner
                ? 'Workspace owner'
                : member.permission === 'editor'
                  ? 'Editor'
                  : member.permission === 'viewer'
                    ? 'Viewer'
                    : 'No brand access';

              const assignedBrandNames = member.brandIds.map(
                (id) => brandNameById.get(id) ?? 'Unavailable brand',
              );
              const ambiguous =
                member.name === 'Workspace member' ||
                members.some((other) => other.userId !== member.userId && other.name === member.name);
              const label = ambiguous
                ? member.name + ' (account ending ' + accountSuffix(member) + ')'
                : member.name;

              return (
                <tr key={member.userId}>
                  <th scope="row">{label}</th>
                  <td>{accessLabel}</td>
                  <td>
                    {isOwner
                      ? 'All brands'
                      : assignedBrandNames.length > 0
                        ? assignedBrandNames.join(', ')
                        : 'No brands'}
                  </td>
                  <td>
                    {isOwner ? (
                      <span className="sr-only">No action available</span>
                    ) : (
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={disabled}
                        onClick={() => onManage(member)}
                      >
                        Manage access<span className="sr-only"> for {label}</span>
                      </button>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
