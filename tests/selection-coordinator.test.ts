import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SelectionCoordinator } from '../src/reader/selection-coordinator';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('invalidates an old quiet-period job and advances its revision', () => {
  const state = new SelectionCoordinator(),
    save = vi.fn();
  const old = state.revision;
  state.schedule(save, 900);
  vi.advanceTimersByTime(899);
  expect(state.invalidate()).toBe(old + 1);
  vi.advanceTimersByTime(1000);
  expect(save).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('replaces a pending release/quiet timer instead of running both', () => {
  const state = new SelectionCoordinator(),
    old = vi.fn(),
    latest = vi.fn();
  state.schedule(old, 0);
  state.schedule(latest, 900);
  vi.advanceTimersByTime(899);
  expect(old).not.toHaveBeenCalled();
  expect(latest).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(latest).toHaveBeenCalledOnce();
});
it('can reschedule from a settled callback and cancel without inventing a new revision', () => {
  const state = new SelectionCoordinator(),
    save = vi.fn();
  state.schedule(() => state.schedule(save, 900), 0);
  vi.advanceTimersByTime(0);
  state.cancel();
  state.cancel();
  vi.advanceTimersByTime(1000);
  expect(save).not.toHaveBeenCalled();
  expect(state.revision).toBe(0);
});
