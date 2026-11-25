import { randomUUID } from 'node:crypto';
import type { Lot } from '../../src/server/workspace-gifts/store.js';

export function fixtureLot(brand: string, at: Date, overrides: Partial<Lot> = {}): Lot {
  const id = randomUUID();
  return {
    id,
    brand,
    account: 'acct_fixture',
    face: 1000,
    fee: 100,
    total: 1100,
    created: at.toISOString(),
    state: 'funded',
    session: 'cs_' + id,
    payment: 'pi_' + id,
    charge: 'ch_' + id,
    paidAt: at.toISOString(),
    reserved: 0,
    spent: 0,
    returned: 0,
    disputed: 0,
    lost: 0,
    disputes: {},
    ...overrides,
  };
}
