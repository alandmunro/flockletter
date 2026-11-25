import { areaCodeZones } from '../../shared/texting.js';
import { localParts, validZone } from '../texting/storage.js';

export type AnnualDate = { month: number; day: number; year: number | null };
const minuteMs = 60_000;
const dayMs = 86_400_000;

export function recipientZones(contactZone: string | null, phone: string | null, workspaceZone: string) {
  const inferred = phone ? areaCodeZones(phone) : [];
  const explicit = contactZone && validZone(contactZone) ? contactZone : null;
  const clock = explicit ?? (inferred.length === 1 ? inferred[0]! : workspaceZone);
  if (!validZone(clock)) throw Error('A valid workspace time zone is required.');
  return { clock, windows: explicit || !inferred.length ? [clock] : inferred };
}

export function anniversaryYears(source: AnnualDate, year: number) {
  return source.year !== null && source.year < year ? year - source.year : null;
}

// Resolve a local civil minute using the UTC offsets on both sides of its date.
// During a fold both candidates match. During a gap choose the first valid wall minute.
export function wallMinute(year: number, month: number, day: number, time: string, zone: string) {
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const localEpoch = (utc: number) => {
    const p = localParts(new Date(utc), zone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  const offsets = [target - dayMs, target + dayMs].map(utc => localEpoch(utc) - utc);
  const candidates = [...new Set(offsets.map(offset => target - offset))].sort((a,b) => a-b);
  const exact = candidates.find(utc => localEpoch(utc) === target);
  if (exact !== undefined) return new Date(exact);
  for (let utc = candidates[0]!; utc <= candidates.at(-1)!; utc += minuteMs)
    if (localEpoch(utc) >= target) return new Date(utc);
  throw Error('Cannot resolve local send time.');
}

export function annualOccurrence(source: AnnualDate, year: number, time: string, zone: string, catchUpDays: number) {
  if (source.year !== null && source.year > year) return null;
  const monthEnd = new Date(Date.UTC(year, source.month, 0)).getUTCDate();
  const observed = source.month === 2 && source.day === 29 ? Math.min(29, monthEnd) : source.day;
  if (source.month < 1 || source.month > 12 || observed < 1 || observed > monthEnd) return null;
  const date = new Date(Date.UTC(year, source.month - 1, observed));
  const cutoff = new Date(date.getTime() + (1 + catchUpDays) * dayMs);
  return {
    localDate: date.toISOString().slice(0,10),
    dueAt: wallMinute(year, source.month, observed, time, zone),
    expiresAt: wallMinute(cutoff.getUTCFullYear(), cutoff.getUTCMonth()+1, cutoff.getUTCDate(), '00:00', zone),
    years: anniversaryYears(source, year),
  };
}
