// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { persistPosition } from '../src/ui/persist-position';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
afterEach(() => vi.useRealTimers());
it('debounces, flushes navigation/disposal, and removes lifecycle listeners', async () => {
  vi.useFakeTimers();
  const viewport = document.createElement('div'); let position = { marker: '' };
  const save = vi.fn(async () => {}), report = vi.fn();
  const tracker = persistPosition(viewport, () => position, save, report);
  for (let offset = 1; offset <= 3; offset++) { position = { marker: 'place ' + offset }; viewport.dispatchEvent(new Event('scroll')); }
  await vi.advanceTimersByTimeAsync(599); expect(save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(save).toHaveBeenCalledExactlyOnceWith({ marker: 'place 3' });
  position = { marker: 'place 4' }; tracker.changed(); tracker.dispose();
  await tracker.flush(); expect(save).toHaveBeenLastCalledWith({ marker: 'place 4' });
  position = { marker: 'place 9' }; window.dispatchEvent(new Event('pagehide')); viewport.dispatchEvent(new Event('scroll'));
  await vi.runAllTimersAsync(); expect(save).toHaveBeenCalledTimes(2); expect(report).not.toHaveBeenCalled();
});
it('preserves a legacy YAML map and reports unsupported format on scroll, pagehide, and close saves', async () => {
  vi.useFakeTimers();
  const path = 'Reading/Inbox/Legacy.md';
  const original = `---
type: article
id: article-id
url: https://example.com/article
reading_position:
  marker: legacy words
  offset: 0.25
---
Article text.`;
  const store = new MemoryStore({ [path]: original }), repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
  const viewport = document.createElement('div'), report = vi.fn(); let position = { marker: '' };
  const tracker = persistPosition(viewport, () => position,
    value => repo.saveReadingPosition(path, value).then(() => undefined), report);
  position = { marker: 'new words' }; viewport.dispatchEvent(new Event('scroll'));
  await vi.runAllTimersAsync();
  position = { marker: 'next words' }; window.dispatchEvent(new Event('pagehide')); await tracker.flush();
  position = { marker: 'close words' }; await tracker.dispose();
  expect(await store.read(path)).toBe(original);
  expect(report).toHaveBeenCalledTimes(3);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Unsupported reading_position') }));
});

it('does not write restored state, flushes pagehide, reports failures and retries', async () => {
  const viewport = document.createElement('div'); let position = { marker: '' };
  const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined), report = vi.fn();
  const tracker = persistPosition(viewport, () => position, save, report);
  position = { marker: 'place 30' }; tracker.restored(); await tracker.flush(); expect(save).not.toHaveBeenCalled();
  position = { marker: 'place 31' }; window.dispatchEvent(new Event('pagehide')); await tracker.flush();
  expect(report).toHaveBeenCalledOnce(); await tracker.flush(); expect(save).toHaveBeenCalledTimes(2);
  tracker.dispose();
});
