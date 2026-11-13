// Workspace preparation and synthetic practice imports retain their limits before billing activation.
export const preparationContactLimit = 250;

export const hostedTrial = {
  days: 14,
  activeContacts: 2_500,
  totalEmails: 2_500,
  cardRequired: true,
} as const;
