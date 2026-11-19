// Twilio's A2P 10DLC business values (docs: messaging/compliance/a2p-10dlc/collect-business-info, checked 2026-11-19).
// The registration form sends these exact strings; anything else is refused by TrustHub.
export const twilioBusinessTypes = ['Limited Liability Corporation', 'Corporation', 'Partnership', 'Co-operative', 'Non-profit Corporation'] as const;
export const twilioIndustries = ['AGRICULTURE', 'AUTOMOTIVE', 'BANKING', 'CONSTRUCTION', 'CONSUMER', 'EDUCATION', 'ELECTRONICS', 'ENGINEERING', 'ENERGY',
  'FAST_MOVING_CONSUMER_GOODS', 'FINANCIAL', 'FINTECH', 'FOOD_AND_BEVERAGE', 'GOVERNMENT', 'HEALTHCARE', 'HOSPITALITY', 'INSURANCE', 'JEWELRY', 'LEGAL',
  'MANUFACTURING', 'MEDIA', 'NOT_FOR_PROFIT', 'OIL_AND_GAS', 'ONLINE', 'PROFESSIONAL_SERVICES', 'RAW_MATERIALS', 'REAL_ESTATE', 'RELIGION', 'RETAIL',
  'TECHNOLOGY', 'TELECOMMUNICATIONS', 'TRANSPORTATION', 'TRAVEL'] as const;
export const carrierEntityTypes = ['private_profit', 'public_profit', 'non_profit', 'sole_proprietor', 'government'] as const;
export type TwilioBusinessType = (typeof twilioBusinessTypes)[number];
export type TwilioIndustry = (typeof twilioIndustries)[number];
export type CarrierEntityType = (typeof carrierEntityTypes)[number];
export type TwilioCompanyType = 'private' | 'non-profit' | 'government';

/**
 * Checks one brand's entity type, business type and industry against Twilio's rules and returns the
 * `company_type` to file. Returns a refusal reason instead when this registration path can't file it:
 * public companies need stock exchange details we don't collect, and sole proprietors without an EIN use
 * a separate Twilio brand path (one with an EIN registers as `private_profit`).
 */
export function twilioBusiness(entityType: string, businessType: unknown, industry: unknown): { companyType: TwilioCompanyType } | { reason: string } {
  if (!twilioBusinessTypes.includes(businessType as TwilioBusinessType)) return { reason: 'business_type_invalid' };
  if (!twilioIndustries.includes(industry as TwilioIndustry)) return { reason: 'industry_invalid' };
  switch (entityType) {
    case 'private_profit': return businessType === 'Non-profit Corporation' ? { reason: 'business_type_mismatch' } : { companyType: 'private' };
    case 'non_profit': return businessType !== 'Non-profit Corporation' ? { reason: 'business_type_mismatch' } : industry !== 'NOT_FOR_PROFIT' ? { reason: 'industry_mismatch' } : { companyType: 'non-profit' };
    case 'government': return businessType !== 'Non-profit Corporation' ? { reason: 'business_type_mismatch' } : industry !== 'GOVERNMENT' ? { reason: 'industry_mismatch' } : { companyType: 'government' };
    case 'public_profit': return { reason: 'public_company_unsupported' };
    case 'sole_proprietor': return { reason: 'sole_proprietor_unsupported' };
    default: return { reason: 'entity_type_invalid' };
  }
}

export const businessRefusals: Record<string, string> = {
  business_type_invalid: 'Choose one of Twilio’s business types.',
  industry_invalid: 'Choose one of Twilio’s industries.',
  business_type_mismatch: 'Use “Non-profit Corporation” only for non-profit and government entities, and only for them.',
  industry_mismatch: 'Non-profit entities use the NOT_FOR_PROFIT industry; government entities use GOVERNMENT.',
  public_company_unsupported: 'Public companies need stock exchange details that this registration path does not collect yet.',
  sole_proprietor_unsupported: 'A sole proprietor with an EIN registers as private_profit; one without an EIN needs Twilio’s separate sole proprietor path, which is not built.',
  entity_type_invalid: 'This entity type is not supported.',
};
