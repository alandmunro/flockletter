/** A new agreement must freeze the explicitly selected collection policy. */
export const billingTaxModes=['off','stripe-automatic'] as const;
export type BillingTaxMode = typeof billingTaxModes[number];
