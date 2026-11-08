type SetupStatusProps = {
  environment: string;
  gaps: readonly string[];
  signedIn?: boolean;
};

export function SetupStatus({ environment, gaps, signedIn = false }: SetupStatusProps) {
  const staging = environment === 'staging';
  const needsClerk = gaps.includes('clerk_not_configured');
  const needsDatabase = gaps.includes('database_not_configured');
  return (
    <section className="auth-card card">
      <h1 className="page-heading">
        {signedIn ? 'You’re signed in.' : staging ? 'Staging setup' : 'Flockletter setup'}
      </h1>
      {needsClerk && (
        <p>
          {staging
            ? 'Connect the staging Clerk application to make sign-in available.'
            : 'Add the publishable and backend keys from your Clerk application to enable sign-in for this installation.'}
        </p>
      )}
      {needsDatabase && (
        <p>Connect the dedicated Flockletter database and apply its migrations to open your workspace.</p>
      )}
      {!needsClerk && !needsDatabase && <p>Complete the workspace configuration to open Flockletter.</p>}
      <a href="https://github.com/alandmunro/flockletter">View the open-source project</a>
    </section>
  );
}
