import { afterEach, expect, it } from 'vitest';
import { EINK_DEVICE_KEY, einkEnabled, normalizeEinkDevice, readEinkDevice, writeEinkDevice } from '../src/eink-device';
const values = new Map<string, string>();
const storage: Storage = { get length() { return values.size; }, clear: () => values.clear(), key: i => [...values.keys()][i] ?? null,
  getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); }, removeItem: key => { values.delete(key); } };
const device = { localStorage: storage };
afterEach(() => values.clear());
it('defaults to scrolling and requires explicit Android e-ink opt-in', () => {
  expect(readEinkDevice(device)).toEqual({ enabled: false, reverseButtons: false });
  expect(einkEnabled(true, readEinkDevice(device))).toBe(false);
  expect(writeEinkDevice(device, { enabled: true, reverseButtons: true })).toBe(true);
  const settings = readEinkDevice(device); expect(einkEnabled(true, settings)).toBe(true);
  expect(einkEnabled(false, settings)).toBe(false); // desktop and iOS ignore any stored opt-in
});
it('retains the existing device preference key across the Reader rename', () => {
  expect(EINK_DEVICE_KEY).toBe('obsidian-reader:boox-eink:v1');
  storage.setItem('obsidian-reader:boox-eink:v1', JSON.stringify({ enabled: true, reverseButtons: true }));
  expect(readEinkDevice(device)).toEqual({ enabled: true, reverseButtons: true });
  expect(writeEinkDevice(device, { enabled: false, reverseButtons: true })).toBe(true);
  expect([...values.keys()]).toEqual(['obsidian-reader:boox-eink:v1']);
  expect(JSON.parse(storage.getItem('obsidian-reader:boox-eink:v1')!)).toEqual({ enabled: false, reverseButtons: true });
});
it('stores only local preferences, not a synced plugin settings object', () => {
  const synced = { useDummyContent: true };
  writeEinkDevice(device, { enabled: true, reverseButtons: false });
  expect(synced).toEqual({ useDummyContent: true });
  expect(JSON.parse(storage.getItem(EINK_DEVICE_KEY)!)).toEqual({ enabled: true, reverseButtons: false });
});
it('rejects corrupt, nonboolean and unknown preferences', () => {
  expect(normalizeEinkDevice({ enabled: 'true', reverseButtons: 1, unknown: true })).toEqual({ enabled: false, reverseButtons: false });
  storage.setItem(EINK_DEVICE_KEY, '{broken'); expect(readEinkDevice(device).enabled).toBe(false);
});
it('handles unavailable local storage without breaking the reader', () => {
  const blocked = { get localStorage(): Storage { throw new Error('unavailable'); } };
  expect(readEinkDevice(blocked).enabled).toBe(false);
  expect(writeEinkDevice(blocked, { enabled: true, reverseButtons: false })).toBe(false);
});
