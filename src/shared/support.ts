import { plans } from './contracts.js';
import { hostedTrial } from './trial.js';
import type { SupportTopic } from './support-topics.js';
export { supportTopics,type SupportTopic } from './support-topics.js';
export const supportAddress = 'support@frostyflamingosoftware.com';
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
          'Verify a card with Stripe, then review and accept the price and first-charge date in Subscription. The trial lasts ' +
          hostedTrial.days +
          ' days, with ' +
          hostedTrial.activeContacts.toLocaleString('en-US') +
          ' active contacts and ' +
          hostedTrial.totalEmails.toLocaleString('en-US') +
          ' recipient emails across the whole trial, with up to two campaigns. Test emails count toward the same allowance.',
      };
    case 'audience':
      return {
        title: 'How do I honor an unsubscribe?',
        text: 'A workspace owner can open Audience, find the exact email address within the brand, open the contact, and confirm Unsubscribe contact. A repeat signup keeps the opt-out.',
      };
    case 'campaigns':
      return {
        title: 'Where did my rehearsal email go?',
        text: 'In Campaigns, open the saved draft and find its rehearsal. Use Open captured email for a completed capture or Show recipient outcomes for a provider test. The Private Listmonk test stays inside Flockletter. Approving Amazon SES mailbox simulator or Listmonk with Amazon SES simulator can send the message only to AWS-owned simulator mailboxes.',
      };
    default:
      return null;
  }
}
