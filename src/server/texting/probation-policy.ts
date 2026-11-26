import { textingSettingValue } from '../../shared/texting.js';
import type { SettingValues } from './storage.js';

export const probationKeys = [
  'probation_canary_count',
  'probation_canary_minutes',
  'probation_min_days',
  'probation_delivered_min',
  'probation_initial_days',
  'probation_initial_daily_limit',
  'probation_daily_limit',
  'probation_risk_window_days',
  'probation_risk_minimum',
  'probation_pause_optout_bps',
  'probation_pause_filter_bps',
  'probation_suspend_optout_bps',
  'probation_suspend_filter_bps',
] as const;
export type ProbationPolicy = Required<Pick<SettingValues, (typeof probationKeys)[number]>>;

export function completePolicy(settings: SettingValues): settings is SettingValues & ProbationPolicy {
  return (
    probationKeys.every((key) => Number.isInteger(settings[key])) &&
    settings.probation_canary_count! <= settings.probation_initial_daily_limit! &&
    settings.probation_initial_daily_limit! <= settings.probation_daily_limit! &&
    settings.probation_initial_days! <= settings.probation_min_days! &&
    settings.probation_pause_filter_bps! < settings.probation_suspend_filter_bps! &&
    settings.probation_pause_optout_bps! < settings.probation_suspend_optout_bps!
  );
}

// A private staging deployment setting supplies defaults to all synthetic companies. Existing
// audited operator overrides still take precedence. No operational thresholds enter the bundle.
export function readProbationPolicy(raw: string | undefined): ProbationPolicy | undefined {
  if (raw === undefined) return undefined;
  try {
    const input = JSON.parse(raw);
    if (!input || Object.keys(input).length !== probationKeys.length) throw Error();
    const settings: SettingValues = {};
    for (const key of probationKeys) {
      const value = textingSettingValue(key, input[key]);
      if (typeof value !== 'number') throw Error();
      settings[key] = value;
    }
    if (!completePolicy(settings)) throw Error();
    return settings;
  } catch {
    throw Error('Configure one complete and consistent private texting probation policy.');
  }
}
