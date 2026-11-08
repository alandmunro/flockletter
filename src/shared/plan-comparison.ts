import type { plans } from './contracts.js';
import type { PlanId, Usage } from './rehearsal.js';

export type PlanCapacity = {
  label: string;
  count: number | null;
  limit: number | null;
  status: 'within' | 'over' | 'unknown';
  guidance: string | null;
};

export type PlanComparison = {
  current: { source: 'preparation' | 'complimentary' | 'stripe_sandbox'; plan: PlanId | null };
  target: (typeof plans)[number];
  fit: 'within_limits' | 'over_limit' | 'needs_verification';
  capacity: PlanCapacity[];
  brands: { id: string; name: string; confirmed: number; exceedsCampaignLimit: boolean }[];
  practice: Usage;
  practiceGuidance: string[];
};
