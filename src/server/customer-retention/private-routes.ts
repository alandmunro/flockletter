// Workspace rows only. The protected operator records and trial history have their own policies.
export const privateWorkspaceRoutes = [
  'scopes',
  'support_reply_routes',
  'confirmation_routes',
  'sending_state',
  'sending_admissions',
  'resend_domain_claims',
  'resend_sender_routes',
  'texting_accounts',
  'texting_number_routes',
  'texting_short_names',
  'texting_link_routes',
  'texting_settings',
  'texting_setting_changes',
] as const;

export const privateWorkspaceTables = privateWorkspaceRoutes.map(name => 'flockletter_customer_jobs.' + name);
