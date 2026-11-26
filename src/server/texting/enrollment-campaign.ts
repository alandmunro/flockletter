import { plainText } from '../../shared/texting.js';
import type { OnboardingBusiness } from '../../shared/texting-onboarding.js';
import type { CampaignInput } from './twilio.js';

const programs = {
  general: { topic: 'business news and offers', samples: ['Our latest business update is available.', 'Here are our holiday opening hours.'] },
  restaurant: { topic: 'menus and restaurant updates', samples: ['Our seasonal menu is available.', 'Here are our new dinner hours.'] },
  realEstate: { topic: 'home care and closing anniversaries', samples: ['Our seasonal home care checklist for past clients is ready.', 'Happy closing anniversary! Thank you for working with us on your home.'] },
};

export function enrollmentCampaign(business: OnboardingBusiness, helpContact: string) {
  const program = business.vertical === 'FOOD_AND_BEVERAGE' ? programs.restaurant : business.vertical === 'REAL_ESTATE' ? programs.realEstate : programs.general;
  const name = business.dbaName ?? business.legalName;
  const sender = plainText(name);
  const recipients = program === programs.realEstate ? 'past clients' : 'customers';
  const { topic } = program;
  const useCase: CampaignInput['useCase'] = business.plan === 'text_2500' ? 'MARKETING' : 'LOW_VOLUME';
  return {
    useCase, description: name + ' sends texts about ' + topic + ' to ' + recipients + ' who opt in and confirm by replying YES.',
    samples: program.samples.map(sample => sender + ': ' + sample + ' Reply STOP to opt out.'),
    flow: (program === programs.realEstate ? 'Past clients' : 'Customers') + ' sign up for ' + topic + ' from ' + name + ' by selecting an optional, unchecked SMS box. The form shows the sender, message frequency, message and data rates, STOP and HELP instructions, and links to both policies. A YES reply is required before receiving these texts.',
    optInMessage: sender + ': Reply YES to confirm texts about ' + topic + '. Msg & data rates may apply. Reply STOP to opt out.',
    helpMessage: sender + ': For help with ' + topic + ', contact ' + plainText(helpContact) + '. Reply STOP to opt out.',
    optOutMessage: sender + ': You are unsubscribed from texts about ' + topic + '. Reply START to resubscribe.',
  };
}

export type EnrollmentCampaign = ReturnType<typeof enrollmentCampaign>;
export type ReviewedCampaign = { signupUrl: string; payload: CampaignInput };

export function reviewEnrollmentCampaign(campaign: EnrollmentCampaign, signupUrl: string, privacyPolicyUrl: string, termsUrl: string): ReviewedCampaign {
  const { flow, ...wording } = campaign;
  const preview = new URL(signupUrl);
  preview.searchParams.set('preview', 'sms');
  return { signupUrl, payload: { ...wording, privacyPolicyUrl, termsUrl, hasLinks: true,
    messageFlow: flow + ' Signup: ' + signupUrl + '. SMS preview before activation: ' + preview.href + '. Privacy policy: ' + privacyPolicyUrl + '. SMS terms: ' + termsUrl + '.' } };
}
