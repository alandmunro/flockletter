import { plans } from './contracts.js';
import { hostedTrial } from './trial.js';
export const supportAddress = 'support@frostyflamingosoftware.com';
export const supportTopics = [
  'plans',
  'trial',
  'audience',
  'campaigns',
  'billing',
  'security',
  'privacy',
  'recovery',
  'other',
] as const;
export type SupportTopic = (typeof supportTopics)[number];
export function supportAnswer(topic: SupportTopic) {
  switch (topic) {
    case 'plans':
      return {
        title: 'What does each plan include?',
        text:
          plans
            .map(
              (p) =>
                p.name +
                ' is $' +
                p.priceMinor / 100 +
                ' per month with ' +
                p.campaigns +
                ' campaigns and ' +
                p.emails.toLocaleString('en-US') +
                ' recipient emails per month.',
            )
            .join(' ') + ' Allowances are shared across the subscription.',
      };
    case 'trial':
      return {
        title: 'When does a trial start?',
        text:
          'The planned hosted trial requires a card and lasts ' +
          hostedTrial.days +
          ' days, with ' +
          hostedTrial.activeContacts +
          ' active contacts and ' +
          hostedTrial.totalEmails +
          ' total recipient emails. Creating a staging workspace does not start a paid trial.',
      };
    case 'audience':
      return {
        title: 'How do I honor an unsubscribe?',
        text: 'A workspace owner can open Audience, find the exact email address within the brand, open the contact, and confirm Unsubscribe contact. A repeat signup keeps the opt-out.',
      };
    case 'campaigns':
      return {
        title: 'Where did my rehearsal email go?',
        text: 'Open Campaigns, choose the saved draft, and look under Campaign rehearsal. A completed rehearsal with a captured message has an Open captured email button. Rehearsals do not deliver external mail.',
      };
    default:
      return null;
  }
}
