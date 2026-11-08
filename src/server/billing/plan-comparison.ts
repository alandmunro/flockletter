import { plans } from '../../shared/contracts.js';
import type { PlanCapacity, PlanComparison } from '../../shared/plan-comparison.js';
import type { PlanId } from '../../shared/rehearsal.js';
import { practiceUsage, utcPeriod, workspaceAccess } from '../campaign/access.js';
import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import type { ClerkTeam } from '../team.js';
import { effectiveSandboxPlan } from './observed-plan.js';

export async function verifiedMemberCount(clerk: ClerkTeam, workspace: string): Promise<number | null> {
  try {
    const { total } = await clerk.members(workspace, 0, 1);
    // The authenticated owner counts as a member.
    return Number.isSafeInteger(total) && total >= 1 ? total : null;
  } catch {
    return null;
  }
}

function capacity(label: string, count: number | null, limit: number | null, guidance: string): PlanCapacity {
  if (count === null) return {
    label, count, limit, status: 'unknown',
    guidance: limit === null ? 'Clerk could not verify the member count. This tier has unlimited seats.' :
      'Reconnect the Clerk directory and check the current member count.',
  };
  const over = limit !== null && count > limit;
  return { label, count, limit, status: over ? 'over' : 'within', guidance: over ? guidance : null };
}

export async function comparePlan(sql: Sql, planId: PlanId, memberCount: number | null): Promise<PlanComparison> {
  requireCondition((await sql.query('SELECT 1 FROM workspaces')).rowCount, 422, 'workspace_required', 'Initialize this workspace first.');
  const target = plans.find(candidate => candidate.id === planId)!;
  const access = await workspaceAccess(sql);
  let current: PlanComparison['current'] = { source: 'preparation', plan: null };
  if (access.plan) current = { source: 'complimentary', plan: access.plan };
  else {
    const verified = (await sql.query<{ id:string; plan: PlanId }>(
      "SELECT id,plan FROM sandbox_checkouts WHERE observed_at IS NOT NULL AND customer_id IS NOT NULL AND subscription_id IS NOT NULL AND status IN ('active','trialing')",
    )).rows[0];
    if (verified) current = { source: 'stripe_sandbox', plan: await effectiveSandboxPlan(sql,verified) };
  }
  const companyCount = (await sql.query<{ count: number }>('SELECT count(*)::int AS count FROM companies')).rows[0]!.count;
  const brands: PlanComparison['brands'] = [];
  const owned = (await sql.query<{ id: string; name: string }>('SELECT id,name FROM brands ORDER BY lower(name),id')).rows;
  for (const brand of owned) {
    await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand.id]);
    const { confirmed } = (await sql.query<{ confirmed: number }>(
      "SELECT count(*)::int AS confirmed FROM subscribers WHERE brand_id=$1 AND state='confirmed'", [brand.id],
    )).rows[0]!;
    brands.push({ ...brand, confirmed, exceedsCampaignLimit: confirmed > target.recipients });
  }
  await sql.query("SELECT set_config('app.intake_brand_id','',true)");
  const capacityChecks = [
    capacity('Companies', companyCount, target.companies, 'Review your companies or choose a tier with enough company slots.'),
    capacity('Brands', brands.length, target.brands, 'Review your brands or choose a tier with enough brand slots.'),
    capacity('Members', memberCount, target.users, 'Review current Clerk memberships or choose a tier with enough seats.'),
    capacity('Confirmed contacts', brands.reduce((sum, b) => sum + b.confirmed, 0), target.contacts,
      'Review the confirmed audience in each brand or choose a tier with more contact capacity.'),
  ];
  const fit = capacityChecks.some(c => c.status === 'over') ? 'over_limit' :
    capacityChecks.some(c => c.status === 'unknown' && c.limit !== null) ? 'needs_verification' : 'within_limits';
  const practice = await practiceUsage(sql, utcPeriod(new Date()));
  const practiceGuidance: string[] = [];
  if (practice.campaigns + practice.reservedCampaigns > target.campaigns)
    practiceGuidance.push('This month’s practiced and reserved campaigns exceed the target allowance. Review the rehearsal schedule.');
  if (practice.messages + practice.reservedMessages > target.emails)
    practiceGuidance.push('This month’s practiced and reserved recipient emails exceed the target allowance. Review the size of scheduled rehearsal audiences.');
  return { current, target, fit, capacity: capacityChecks, brands, practice, practiceGuidance };
}
