import { DEFAULT_SETTINGS, type ReaderSettings } from './types';

/** Normalize in memory; the marker is persisted only on an ordinary settings save. */
export function normalizeFeedSchedule(saved: unknown): Pick<ReaderSettings, 'pollMinutes' | 'feedScheduleVersion'> {
  const data = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  const version = typeof data.feedScheduleVersion === 'number' && Number.isFinite(data.feedScheduleVersion)
    ? data.feedScheduleVersion : 0;
  const interval = typeof data.pollMinutes === 'number' && Number.isFinite(data.pollMinutes)
    ? data.pollMinutes : DEFAULT_SETTINGS.pollMinutes;
  // Old settings cannot distinguish an explicit 30 from the previous default.
  const migrated = version < 1 && interval === 30 ? DEFAULT_SETTINGS.pollMinutes : interval;
  return {
    pollMinutes: Math.max(5, Math.min(1440, migrated || DEFAULT_SETTINGS.pollMinutes)),
    feedScheduleVersion: Math.max(1, version),
  };
}
