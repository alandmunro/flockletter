import { z } from 'zod';
import { textingSettingKeys, registrationSteps, campaignUseCases } from './texting.js';
import { mockFaults, mockRegistrationScenarios } from './texting-mock.js';
import { carrierEntityTypes, twilioBusinessTypes, twilioIndustries } from './texting-business.js';

// Operator-only texting commands. Customer connection scopes never grant these (FL-SMS-003/013).
const operationKey = z.uuid(), reason = z.string().trim().min(12).max(400);
const workspaceId = z.string().regex(/^org_[A-Za-z0-9_-]{1,120}$/);
const define = <T extends z.ZodRawShape>(description: string, mutation: boolean, shape: T) => ({ description, mutation, schema: z.object(shape).strict() });
const text = (max: number) => z.string().trim().min(1).max(max);
const businessProfile = z.object({
  ein: z.string().regex(/^\d{2}-?\d{7}$/), website: z.url().max(300), businessType: z.enum(twilioBusinessTypes), vertical: z.enum(twilioIndustries), areaCode: z.string().regex(/^[2-9]\d{2}$/).optional(),
  address: z.object({ street: text(120), city: text(60), region: z.string().regex(/^[A-Z]{2}$/), postalCode: z.string().regex(/^\d{5}(-\d{4})?$/), country: z.literal('US') }).strict(),
  contact: z.object({ firstName: text(60), lastName: text(60), email: z.email().max(254), phone: z.string().regex(/^\+1\d{10}$/), title: text(60) }).strict(),
}).strict();
// Carriers reject campaigns whose description and samples don't match the business, so each brand files its own.
const campaignWording = z.object({
  description: z.string().trim().min(40).max(4096),
  samples: z.array(z.string().trim().min(20).max(1024)).min(2).max(5),
  // LOW_VOLUME is Twilio's Low Volume Mixed campaign: under about 2,000 segments a day on T-Mobile, a lower monthly fee.
  useCase: z.enum(campaignUseCases).optional(),
  // The sign-up checkbox also covers texts about the subscriber's booked stays, and the campaign filing says so.
  stayTexts: z.boolean().optional(),
}).strict();
const mockAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('registration_scenario'), registrationId: z.uuid(), scenario: z.enum(mockRegistrationScenarios), reason }).strict(),
  z.object({ kind: z.literal('fault'), target: z.enum([...registrationSteps, 'send']), faults: z.array(z.enum(mockFaults)).min(1).max(10) }).strict(),
  z.object({ kind: z.literal('brand'), registrationId: z.uuid(), status: z.enum(['APPROVED', 'FAILED', 'SUSPENDED']), errorCode: z.string().regex(/^30[789]\d{2}$/).optional() }).strict(),
  z.object({ kind: z.literal('campaign'), registrationId: z.uuid(), status: z.enum(['VERIFIED', 'FAILED', 'SUSPENDED']), errorCode: z.string().regex(/^30[789]\d{2}$/).optional() }).strict(),
  z.object({ kind: z.literal('inbound'), from: z.string().regex(/^\+1\d{10}$/), to: z.string().regex(/^\+1\d{10}$/), body: z.string().min(1).max(320) }).strict(),
  z.object({ kind: z.literal('release_held_broadcast'), sendId: z.uuid(), reason }).strict(),
  z.object({ kind: z.literal('deliver') }).strict(),
]);
export const textingPlatformCommands = {
  'platform.textingSettings': define('Read every texting setting with its safe bounds, the platform value and any workspace override.', false, { workspaceId: workspaceId.optional() }),
  'platform.textingSettingHistory': define('Read the audited history of texting setting changes (old value, new value, actor, interface, reason).', false, { workspaceId: workspaceId.optional() }),
  'platform.textingSetSetting': define('Set or clear one texting setting within its safe bounds, platform-wide or for one workspace. Takes effect without a deployment and is audited.', true, {
    operationKey, key: z.enum(textingSettingKeys as [string, ...string[]]), workspaceId: workspaceId.nullable(), value: z.json().nullable(), expectedRevision: z.number().int().min(0), reason }),
  'platform.textingCarrierBrand': define('Create, or correct while draft or rejected, the one carrier brand for a company (FL-SMS-002). Live registration also needs the campaign description and 2 to 5 sample texts written for this business.', true, {
    operationKey, workspaceId, companyId: z.uuid(), legalName: text(200), dbaName: text(200).nullable(),
    entityType: z.enum(carrierEntityTypes), profile: businessProfile, campaign: campaignWording.optional(), helpContact: text(120), reason }),
  'platform.textingCampaignWording': define('Set the campaign description, samples, use case and stay-text coverage for one carrier brand, any time before its campaign is filed. Changing stay-text coverage clears the policy confirmation, so the SMS terms are confirmed again before filing.', true, {
    operationKey, workspaceId, carrierBrandId: z.uuid(), campaign: campaignWording, reason }),
  'platform.textingConfirmPolicies': define('Record that the business’s website privacy policy and SMS terms are live. Carrier registration waits for this.', true, {
    operationKey, workspaceId, carrierBrandId: z.uuid(), privacyPolicyUrl: z.url().max(300), smsTermsUrl: z.url().max(300), reason }),
  'platform.textingSubmit': define('Start, or restart after correction, carrier registration for one carrier brand. In live mode each brand, campaign and number step also needs platform.textingApprove.', true, {
    operationKey, workspaceId, registrationId: z.uuid(), reason }),
  'platform.textingApprove': define('Live mode only: approve one real carrier or cost action (brand, campaign or number) for the current registration revision.', true, {
    operationKey, workspaceId, registrationId: z.uuid(), step: z.enum(['brand', 'campaign', 'number']), costNote: text(200), reason }),
  'platform.textingCampaignResubmitted': define('Record that a FAILED campaign was edited and resubmitted in the Twilio Console (same campaign, no new vetting fee). Registration goes back to waiting on its status.', true, {
    operationKey, workspaceId, registrationId: z.uuid(), reason }),
  'platform.textingRegistration': define('Read registration state, every step with its operation key, and numbers for one workspace.', false, { workspaceId }),
  'platform.textingEvidenceCase': define('Manage one assigned fictional evidence case with current multifactor verification.', true, {
    operationKey, workspaceId, companyId: z.uuid(), caseId: z.uuid(),
    action: z.enum(['claim','view','hold','release_hold']),
    holdReason: z.enum(['carrier_appeal','legal_hold']).optional(), reviewAt: z.iso.datetime().optional(),
  }),
  'platform.textingOnboardingReview': define('Return a practice enrollment for correction or end its probation with an audit reason.', true, {
    operationKey, workspaceId, companyId: z.uuid(), expectedRevision: z.number().int().positive(),
    action: z.enum(['request_correction', 'complete_probation', 'accept_evidence', 'lift_suspension', 'void_practice_receipt']), expectedReceipt: z.string().regex(/^[0-9a-f]{64}$/).optional(), reason,
  }),
  'platform.textingProcess': define('Run one texting worker pass for a workspace now.', true, { operationKey, workspaceId }),
  'platform.textingMock': define('Staging mock only: script provider faults, decide brand or campaign status, deliver queued callbacks, or receive a text from a phone.', true, {
    operationKey, workspaceId, action: mockAction }),
};
export type TextingPlatformCommand = keyof typeof textingPlatformCommands;
