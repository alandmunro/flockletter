import type { Workspace } from '../shared/contracts.js';

export type OnboardingProgressProps = {
  workspace: Pick<Workspace, 'name' | 'brands' | 'entitlement'> | null;
  hasDraft?: boolean;
  onNavigate: (page: 'settings' | 'campaigns') => void;
};

export function OnboardingProgress({ workspace, hasDraft, onNavigate }: OnboardingProgressProps) {
  const brandNames = workspace?.brands.map((brand) => brand.name) ?? [];
  const savedDraft = Boolean(workspace && brandNames.length && hasDraft);
  const steps = [
    {
      label: 'Workspace',
      status: workspace ? 'Complete' : 'Upcoming',
      detail: workspace?.name ?? 'Create a workspace after signing in.',
    },
    {
      label: 'First brand',
      status: brandNames.length ? 'Complete' : 'Upcoming',
      detail: brandNames.length ? brandNames.join(', ') : 'Name your first sending brand.',
    },
    {
      label: 'First campaign draft',
      status: savedDraft
        ? 'Complete'
        : hasDraft === false && workspace && brandNames.length
          ? 'Ready to start'
          : 'Upcoming',
      detail: savedDraft
        ? 'A campaign draft is saved in this workspace.'
        : 'Create a draft and preview it before sending.',
    },
    {
      label: 'Service access',
      status: workspace?.entitlement === 'complimentary' ? 'Complimentary' : 'Upcoming',
      detail:
        workspace?.entitlement === 'complimentary'
          ? 'An operator has granted this workspace complimentary access.'
          : 'Draft preparation is available before service activation.',
    },
    {
      label: 'Live delivery',
      status: 'Upcoming',
      detail: 'Live campaigns require a verified sender and eligible recipients.',
    },
  ];
  return (
    <section className="card onboarding-progress" aria-labelledby="onboarding-progress-title">
      <h2 id="onboarding-progress-title">Workspace setup</h2>
      <ol className="setup-steps">
        {steps.map((step) => (
          <li key={step.label}>
            <div>
              <strong>{step.label}</strong>
              <span>{step.status}</span>
            </div>
            <p>{step.detail}</p>
          </li>
        ))}
      </ol>
      {workspace && (
        <div className="actions">
          <button type="button" className="btn secondary" onClick={() => onNavigate('settings')}>
            View workspace
          </button>
          {brandNames.length > 0 && (
            <button type="button" className="btn secondary" onClick={() => onNavigate('campaigns')}>
              Open campaigns
            </button>
          )}
        </div>
      )}
    </section>
  );
}
