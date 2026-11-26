export const mockFaults = ['429', '5xx', 'timeout_after_commit', 'reject', 'invalid', 'landline', 'unsubscribed', 'undelivered', 'failed'] as const;
export type MockFault = typeof mockFaults[number];

export const mockRegistrationScenarios = ['lose_number_notice', 'reject_campaign_terms'] as const;
export type MockRegistrationScenario = typeof mockRegistrationScenarios[number];
