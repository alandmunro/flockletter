import { expect, it } from 'vitest';
import { annualOccurrence, recipientZones, wallMinute } from '../src/server/date-automations/calendar.js';
it('observes leap birthdays and computes anniversary years only after the original year', () => {
  const date={month:2,day:29,year:null};
  expect(annualOccurrence(date,2027,'09:15','America/New_York',2)).toMatchObject({localDate:'2027-02-28',years:null,dueAt:new Date('2027-02-28T14:15Z'),expiresAt:new Date('2027-03-03T05:00Z')});
  expect(annualOccurrence({...date,year:2024},2028,'09:15','America/New_York',2)).toMatchObject({localDate:'2028-02-29',years:4});
  expect(annualOccurrence({...date,year:2028},2027,'09:15','UTC',2)).toBeNull();
  expect(annualOccurrence({month:4,day:31,year:null},2027,'09:15','UTC',2)).toBeNull();
});
it('chooses the first possible minute in a gap and the earlier copy in a fold', () => {
  expect(wallMinute(2026,3,8,'02:20','America/New_York').toISOString()).toBe('2026-03-08T07:00:00.000Z');
  expect(wallMinute(2026,11,1,'01:45','America/New_York').toISOString()).toBe('2026-11-01T05:45:00.000Z');
});
it('uses a known zone ahead of phone inference and requires a valid fallback', () => {
  expect(recipientZones('America/Denver','+12125551000','America/Chicago').clock).toBe('America/Denver');
  expect(recipientZones(null,null,'America/Chicago').windows).toEqual(['America/Chicago']);
  expect(()=>recipientZones(null,null,'invalid')).toThrow();
});
it('uses the workspace clock and both SMS windows for an ambiguous area code', () => {
  const phone = '+13085550100';
  expect(recipientZones(null, phone, 'America/New_York')).toEqual({
    clock: 'America/New_York', windows: ['America/Chicago', 'America/Denver'],
  });
  expect(recipientZones('America/Boise', phone, 'America/New_York')).toEqual({
    clock: 'America/Boise', windows: ['America/Boise'],
  });
});

it('expires after the configured number of local days across a Denver clock change', () => {
  const source = {month:10,day:31,year:null};
  const occurrence = (days:number) => annualOccurrence(source,2026,'09:15','America/Denver',days);
  expect(occurrence(0)?.expiresAt).toEqual(new Date('2026-11-01T06:00Z'));
  expect(occurrence(2)?.expiresAt).toEqual(new Date('2026-11-03T07:00Z'));
});
