import { expect, it } from 'vitest';
import { deliveryBindings, runDeliveryQueue } from '../src/server/campaign/delivery-runner.js';

const first = { workspace: 'org_alpha', brand: 'ac0e5a72-a135-424e-93e4-c8c0fa2a324f' };
const second = { workspace: 'org_beta', brand: 'ac0e5a72-a135-424e-93e4-c8c0fa2a325a' };
it('accepts only explicit scoped bindings, including the existing staging pilot once', () => {
  expect(deliveryBindings({})).toEqual([]);
  expect(
    deliveryBindings({
      FLOCKLETTER_CAPTURE_WORKSPACE: first.workspace,
      FLOCKLETTER_CAPTURE_BRAND: first.brand,
      FLOCKLETTER_DELIVERY_BINDINGS: JSON.stringify([first, second]),
    }),
  ).toEqual([first, second]);
  expect(() =>
    deliveryBindings({ FLOCKLETTER_DELIVERY_BINDINGS: '[{"workspace":"*","brand":"*"}]' }),
  ).toThrow();
  expect(() => deliveryBindings({ FLOCKLETTER_CAPTURE_WORKSPACE: first.workspace })).toThrow();
});
it('continues a healthy scope when another fails and drains active work before stopping', async () => {
  const stop = new AbortController(),
    called: string[] = [];
  let errors = 0;
  await runDeliveryQueue(
    [first, second],
    async (w) => {
      called.push(w);
      if (w === first.workspace) throw new Error('temporary');
      if (called.length >= 4) stop.abort();
      return { processed: true };
    },
    stop.signal,
    () => {
      errors++;
    },
    async () => {
      throw new Error('unexpected idle wait');
    },
  );
  expect(errors).toBe(1);
  expect(called).toEqual([first.workspace, second.workspace, second.workspace, second.workspace]);
});
