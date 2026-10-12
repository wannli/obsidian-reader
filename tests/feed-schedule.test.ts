import { describe, expect, it } from 'vitest';
import { normalizeFeedSchedule } from '../src/feed-schedule';
import { DEFAULT_SETTINGS } from '../src/types';

describe('feed schedule settings migration', () => {
  it('defaults new and old-default installs to four hours without mutating saved data', () => {
    expect(DEFAULT_SETTINGS.pollMinutes).toBe(240);
    for (const saved of [undefined, null, {}, { pollMinutes: 30 }, { pollMinutes: 30, feedScheduleVersion: 0 }]) {
      const before = JSON.stringify(saved);
      expect(normalizeFeedSchedule(saved)).toEqual({ pollMinutes: 240, feedScheduleVersion: 1 });
      expect(JSON.stringify(saved)).toBe(before);
    }
  });
  it.each([5, 60, 120, 240, 1440])('preserves a custom %i-minute interval', pollMinutes => {
    expect(normalizeFeedSchedule({ pollMinutes })).toEqual({ pollMinutes, feedScheduleVersion: 1 });
  });
  it('lets users choose 30 minutes after migration and a normal settings save', () => {
    const settings = { ...DEFAULT_SETTINGS, ...normalizeFeedSchedule({ pollMinutes: 30 }) };
    settings.pollMinutes = 30;
    expect(normalizeFeedSchedule(JSON.parse(JSON.stringify(settings)))).toEqual({ pollMinutes: 30, feedScheduleVersion: 1 });
  });
  it.each([undefined, '30', NaN, Infinity, 0])('uses the new fallback for invalid input %s', pollMinutes => {
    expect(normalizeFeedSchedule({ pollMinutes }).pollMinutes).toBe(240);
  });
  it('retains bounds and forward-compatible migration markers', () => {
    expect(normalizeFeedSchedule({ pollMinutes: 1 }).pollMinutes).toBe(5);
    expect(normalizeFeedSchedule({ pollMinutes: 2000 }).pollMinutes).toBe(1440);
    expect(normalizeFeedSchedule({ pollMinutes: 30, feedScheduleVersion: 2 })).toEqual({ pollMinutes: 30, feedScheduleVersion: 2 });
  });
});
