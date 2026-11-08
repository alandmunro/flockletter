import { describe, expect, it } from 'vitest';
import { reviewDate } from '../src/server/retention.js';
describe('retention rehearsal', () => {
  it('counts 90 full days from the verified effective service end across leap days and time changes', () => {
    expect(reviewDate(new Date('2028-01-01T12:00:00Z')).toISOString()).toBe('2028-03-31T12:00:00.000Z');
    expect(reviewDate(new Date('2026-11-01T07:32:15Z')).toISOString()).toBe('2027-01-30T07:32:15.000Z');
  });
});
