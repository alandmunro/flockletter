import { expect, it } from 'vitest';
import type Stripe from 'stripe';
import {
  scheduledDowngradePlan,
  type ExpectedSchedule,
} from '../src/server/customer-billing/scheduled-plan.js';

const start = 1804723200;
const end = start + 30 * 86400;
function baseExpected(overrides: Partial<ExpectedSchedule> = {}): ExpectedSchedule {
  return {
    scheduleId: 'sub_sched_fixture',
    subscriptionId: 'sub_fixture',
    customerId: 'cus_fixture',
    live: false,
    periodStart: start,
    periodEnd: end,
    currentPlan: 'pro',
    prices: { starter: 'price_starter', growth: 'price_growth', pro: 'price_pro' },
    ...overrides,
  };
}
function phase(price: string, from = start, until = end) {
  return {
    start_date: from,
    end_date: until,
    items: [{ price, quantity: 1 }],
  } as Stripe.SubscriptionSchedule.Phase;
}
function baseSchedule(expected = baseExpected()): Stripe.SubscriptionSchedule {
  return {
    id: expected.scheduleId,
    livemode: expected.live,
    status: 'active',
    subscription: expected.subscriptionId,
    customer: expected.customerId,
    current_phase: { start_date: expected.periodStart, end_date: expected.periodEnd },
    phases: [
      phase(expected.prices[expected.currentPlan], expected.periodStart, expected.periodEnd),
      phase('price_growth', expected.periodEnd, expected.periodEnd + 30 * 86400),
    ],
  } as Stripe.SubscriptionSchedule;
}
const sanitized = 'The Flockletter billing schedule could not be verified.';

it('projects only an immediate next-renewal downgrade without changing the provider object', () => {
  const expected = baseExpected();
  const schedule = baseSchedule(expected);
  const before = structuredClone(schedule);
  expect(scheduledDowngradePlan(schedule, expected)).toBe('growth');
  expect(schedule).toEqual(before);
  expected.currentPlan = 'growth';
  schedule.phases[0] = phase('price_growth');
  schedule.phases[1] = phase('price_starter', end, end + 30 * 86400);
  expect(scheduledDowngradePlan(schedule, expected)).toBe('starter');
});

it('supports expanded customer, subscription and price references using their exact IDs', () => {
  const expected = baseExpected({ live: true });
  const schedule = baseSchedule(expected);
  schedule.customer = { id: expected.customerId } as Stripe.Customer;
  schedule.subscription = { id: expected.subscriptionId } as Stripe.Subscription;
  schedule.phases[0]!.items[0]!.price = { id: 'price_pro' } as Stripe.Price;
  schedule.phases[1]!.items[0]!.price = { id: 'price_growth' } as Stripe.Price;
  expect(scheduledDowngradePlan(schedule, expected)).toBe('growth');
});

it('returns null without a future phase and permits contiguous historical phases', () => {
  const expected = baseExpected();
  const schedule = baseSchedule(expected);
  schedule.phases = [phase('price_starter', start - 30 * 86400, start), schedule.phases[0]!];
  expect(scheduledDowngradePlan(schedule, expected)).toBeNull();
});

it('does not project a later phase and still rejects malformed later chronology', () => {
  const expected = baseExpected();
  const schedule = baseSchedule(expected);
  schedule.phases.push(phase('price_pro', end + 30 * 86400, end + 60 * 86400));
  expect(scheduledDowngradePlan(schedule, expected)).toBe('growth');
  schedule.phases[2]!.start_date++;
  expect(() => scheduledDowngradePlan(schedule, expected)).toThrow(sanitized);
});

type Mutation = (schedule: Stripe.SubscriptionSchedule, expected: ExpectedSchedule) => void;
const invalidGraphs: [string, Mutation][] = [
  ['wrong schedule', (s) => { s.id = 'sub_sched_foreign'; }],
  ['wrong customer', (s) => { s.customer = 'cus_foreign'; }],
  ['wrong subscription', (s) => { s.subscription = 'sub_foreign'; }],
  ['missing subscription', (s) => { s.subscription = null; }],
  ['wrong mode', (s) => { s.livemode = true; }],
  ['missing current phase', (s) => { s.current_phase = null; }],
  ['wrong current phase start', (s) => { s.current_phase!.start_date--; }],
  ['wrong current phase end', (s) => { s.current_phase!.end_date++; }],
  ['no phases', (s) => { s.phases = []; }],
  ['no matching current phase', (s) => { s.phases[0]!.start_date--; }],
  ['duplicate current phase', (s) => { s.phases.unshift(structuredClone(s.phases[0]!)); }],
  ['duplicate next phase', (s) => { s.phases.push(structuredClone(s.phases[1]!)); }],
  ['future gap', (s) => { s.phases[1]!.start_date++; }],
  ['future overlap', (s) => { s.phases[1]!.start_date--; }],
  ['reversed phase order', (s) => { s.phases.reverse(); }],
  ['historical gap', (s) => { s.phases.unshift(phase('price_starter', start - 30 * 86400, start - 1)); }],
  ['duplicate catalogue IDs', (_, e) => { e.prices.growth = e.prices.pro; }],
  ['invalid catalogue ID', (_, e) => { e.prices.starter = 'not_a_price'; }],
  ['empty expected schedule ID', (_, e) => { e.scheduleId = ''; }],
  ['empty expected subscription ID', (_, e) => { e.subscriptionId = ''; }],
  ['empty expected customer ID', (_, e) => { e.customerId = ''; }],
  ['reversed expected bounds', (_, e) => { e.periodEnd = e.periodStart - 1; }],
  ['equal expected bounds', (_, e) => { e.periodEnd = e.periodStart; }],
];
it.each(invalidGraphs)('rejects %s with a sanitized error', (_, mutate) => {
  const expected = baseExpected();
  const schedule = baseSchedule(expected);
  mutate(schedule, expected);
  expect(() => scheduledDowngradePlan(schedule, expected)).toThrow(new Error(sanitized));
});

it.each(['not_started', 'canceled', 'completed', 'released', 'unknown'])('rejects schedule state %s', (state) => {
  const expected = baseExpected();
  const schedule = baseSchedule(expected);
  schedule.status = state;
  expect(() => scheduledDowngradePlan(schedule, expected)).toThrow(sanitized);
});

it.each([0, 1])('requires exactly one recognized quantity-one item in phase %i', (index) => {
  const expected = baseExpected();
  for (const quantity of [undefined, 0, 2, 1.5, Number.NaN]) {
    const schedule = baseSchedule(expected);
    schedule.phases[index]!.items[0]!.quantity = quantity;
    expect(() => scheduledDowngradePlan(schedule, expected)).toThrow(sanitized);
  }
  for (const price of ['price_foreign', index === 0 ? 'price_starter' : 'price_pro']) {
    const schedule = baseSchedule(expected);
    schedule.phases[index]!.items[0]!.price = price;
    expect(() => scheduledDowngradePlan(schedule, expected)).toThrow(sanitized);
  }
  for (const count of [0, 2]) {
    const schedule = baseSchedule(expected);
    const item = schedule.phases[index]!.items[0]!;
    schedule.phases[index]!.items = Array.from({ length: count }, () => structuredClone(item));
    expect(() => scheduledDowngradePlan(schedule, expected)).toThrow(sanitized);
  }
});

it.each(['growth', 'pro'] as const)('rejects a future %s plan that is not cheaper', (next) => {
  const expected = baseExpected({ currentPlan: 'growth' });
  const schedule = baseSchedule(expected);
  schedule.phases[1]!.items[0]!.price = expected.prices[next];
  expect(() => scheduledDowngradePlan(schedule, expected)).toThrow(sanitized);
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.5, -1])(
  'rejects invalid expected or phase timestamp %s',
  (invalid) => {
    const expected = baseExpected();
    const schedule = baseSchedule(expected);
    for (const field of ['periodStart', 'periodEnd'] as const)
      expect(() => scheduledDowngradePlan(schedule, { ...expected, [field]: invalid })).toThrow(sanitized);
    for (const field of ['start_date', 'end_date'] as const) {
      const malformed = structuredClone(schedule);
      malformed.phases[1]![field] = invalid;
      expect(() => scheduledDowngradePlan(malformed, expected)).toThrow(sanitized);
    }
  },
);

it('rejects zero-duration and reversed phase bounds', () => {
  const expected = baseExpected();
  for (const duration of [0, -1]) {
    const schedule = baseSchedule(expected);
    schedule.phases[1]!.end_date = schedule.phases[1]!.start_date + duration;
    expect(() => scheduledDowngradePlan(schedule, expected)).toThrow(sanitized);
  }
});
