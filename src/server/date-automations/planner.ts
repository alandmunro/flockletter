import { nextWindow } from '../texting/storage.js';
import { annualOccurrence, recipientZones } from './calendar.js';
import type { DateSource } from './sources.js';
import type { DateSettings } from '../../shared/date-automations.js';

export function schedule(source:DateSource, year:number, settings:DateSettings) {
  const zones=recipientZones(source.time_zone,source.phone_e164,settings.zone);
  const annual=annualOccurrence(source,year,settings.time,zones.clock);
  if (!annual) return null;
  const dueAt=nextWindow(annual.dueAt,zones.windows,settings.startHour,settings.endHour);
  return {...annual, dueAt, zone:zones.clock};
}
