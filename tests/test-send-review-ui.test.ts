import { describe, expect, it } from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement,type ComponentProps} from 'react';
import type { TestDeliveryReview } from '../src/shared/customer-test-send.js';
import { TestSendReview } from '../src/client/TestSendReview.js';

const base: TestDeliveryReview = {
  purpose: 'test', testSubscriberId: '00000000-0000-4000-8000-000000000001',
  testDay:null,testAdmittedAt:null,
  id: '11111111-1111-4111-8111-111111111111',
  brandId: '22222222-2222-4222-8222-222222222222',
  campaignId: '33333333-3333-4333-8333-333333333333',
  version: 1, subject: '[TEST] Trail', state: 'reviewed', mode: 'capture',
  dueAt: '2025-06-01T09:00:00Z', createdAt: '2025-05-31T10:00:00Z',
  selected: 1, excluded: 0, pending: 1, preparing: 0, submitting: 0,
  accepted: 0, uncertain: 0, rejected: 0, skipped: 0, delivered: 0,
  hardBounced: 0, complained: 0, reason: null, recipients: [], senderProfile: null,
};

const noop = () => {};
function render(overrides:Partial<TestDeliveryReview>={},props:Partial<Pick<ComponentProps<typeof TestSendReview>,'canApprove'|'busy'>>={}){
  return renderToStaticMarkup(createElement(TestSendReview,{review:{...base,...overrides},recipientLabel:'reader@example.test',canApprove:true,busy:false,
    onApprove:noop,onProcess:noop,onResume:noop,onCancel:noop,onPreview:noop,onRefresh:noop,...props}));
}

describe('TestSendReview', () => {
  it('explicit one-recipient approval, captured mode, no external evidence', () => {
    const html = render();
    expect(html).toContain('One-recipient test review');
    expect(html).toContain('no external email');
    expect(html).toContain('Approve one-recipient test');
    expect(html).not.toMatch(/<button(?=[^>]*disabled)[^>]*>Approve one-recipient test<\/button>/);
  });

  it('canApprove false disables approval button', () => {
    const html = render({}, { canApprove: false });
    expect(html).toMatch(/<button(?=[^>]*disabled)[^>]*>Approve one-recipient test<\/button>/);
  });

  it('busy disables approval button', () => {
    const html = render({}, { busy: true });
    expect(html).toMatch(/<button(?=[^>]*disabled)[^>]*>Approve one-recipient test<\/button>/);
  });

  it('offers only paused tests an explicit unchanged resume action',()=>{
    expect(render({state:'paused'})).toContain('Resume unchanged test');
    expect(render({state:'queued'})).not.toContain('Resume unchanged test');
  });

  it('queued state does not show Approve button', () => {
    const html = render({ state: 'queued' });
    expect(html).not.toContain('Approve one-recipient test');
  });

  it('capture accepted row uses Captured acceptance/feedback labels', () => {
    const html = render({ mode: 'capture',state:'completed',pending:0,accepted:1,delivered:1 });
    expect(html).toContain('Captured acceptance');
    expect(html).toContain('Captured delivered feedback');
  });

  it('ses accepted explicitly says does not confirm inbox delivery', () => {
    const html = render({ mode:'ses',state:'completed',pending:0,accepted:1 });
    expect(html).toContain('does not confirm inbox delivery');
  });

  it('uncertain warning says reconcile original, do not create replacement', () => {
    const html = render({ uncertain: 1 });
    expect(html).toContain('Reconcile this original test');
    expect(html).toContain('do not create a replacement');
  });

  it('server testDay shown, midnight UTC expiry, immediate no future schedule', () => {
    const html=render({state:'queued',testDay:'2025-06-01',testAdmittedAt:'2025-06-01T12:00:00Z'});
    expect(html).toContain('2025-06-01');
    expect(html).toContain('midnight UTC');
    expect(html).toContain('Immediate after explicit approval');
    expect(html).toContain('no future schedule');
  });

  it('cancellation not refund policy, recipient email 0 campaign slots', () => {
    const html = render({ state: 'cancelled' });
    expect(html).toContain('Cancellation cannot recall already-accepted messages');
    expect(html).toContain('0 campaign slots');
  });
});
