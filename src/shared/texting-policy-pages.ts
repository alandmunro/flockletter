export type HostedPolicySnapshot = {
  legalName: string;
  publicContact: string;
  description: string;
  signupUrl: string;
  revision: number;
  acceptedAt: string;
  template: 'practice-sms-v1';
  privacy: string;
  terms: string;
};

/** The published address always comes from the company's own enabled signup route. */
export function hostedBusinessUrls(signupUrl: string) {
  const signup = new URL(signupUrl);
  const slug = /^\/signup\/([a-z0-9][a-z0-9-]*)$/i.exec(signup.pathname)?.[1];
  if (!slug || signup.search || signup.hash) throw new Error('A company signup page is required.');
  const website = new URL('/business/' + slug, signup.origin).href;
  return { website, privacyPolicyUrl: website + '/privacy', smsTermsUrl: website + '/sms-terms' };
}

export function policyPreview(legalName: string, publicContact: string, description: string) {
  return {
    privacy: legalName + ' uses your mobile number and consent record to manage your subscription and deliver the texts you request. Mobile opt-in data and consent will not be sold or shared with third parties for marketing. We use service providers to operate the messaging program. Contact ' + publicContact + ' with questions about your data.',
    terms: 'By opting in, you agree to receive recurring marketing texts from ' + legalName + '. ' + description + ' Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is optional and is not a condition of purchase. Contact ' + publicContact + ' for assistance.',
  };
}

export function makeHostedPolicySnapshot(input: Omit<HostedPolicySnapshot, 'template' | 'privacy' | 'terms'>): HostedPolicySnapshot {
  return { ...input, template: 'practice-sms-v1', ...policyPreview(input.legalName, input.publicContact, input.description) };
}
