/** Device-local preferences only: never put these in synced plugin data.json. */
// Preserve the existing device preference key; renaming it requires migration approval.
export const EINK_DEVICE_KEY = 'obsidian-reader:boox-eink:v1';
export interface EinkDeviceSettings { enabled: boolean; reverseButtons: boolean; }
export const DEFAULT_EINK_DEVICE: Readonly<EinkDeviceSettings> = Object.freeze({ enabled: false, reverseButtons: false });
export function normalizeEinkDevice(value: unknown): EinkDeviceSettings {
  const data = value && typeof value === 'object' ? value as Partial<EinkDeviceSettings> : {};
  return { enabled: data.enabled === true, reverseButtons: data.reverseButtons === true };
}
export function readEinkDevice(win: Pick<Window, 'localStorage'>): EinkDeviceSettings {
  try { return normalizeEinkDevice(JSON.parse(win.localStorage.getItem(EINK_DEVICE_KEY) ?? 'null')); }
  catch { return { ...DEFAULT_EINK_DEVICE }; }
}
export function writeEinkDevice(win: Pick<Window, 'localStorage'>, settings: EinkDeviceSettings): boolean {
  try { win.localStorage.setItem(EINK_DEVICE_KEY, JSON.stringify(normalizeEinkDevice(settings))); return true; }
  catch { return false; }
}
/** Android alone is NOT e-ink detection: the Boox user must explicitly opt in. */
export function einkEnabled(isAndroid: boolean, settings: EinkDeviceSettings): boolean { return isAndroid && settings.enabled; }
