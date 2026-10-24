import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RowIndicators, IndicatorReadSlots } from '../src/reader/row-indicators';
import { gate } from './helpers/memory-vault';

const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));
vi.mock('obsidian', () => ({ setIcon: vi.fn(), setTooltip: vi.fn() }));
class Observer {
  static instances: Observer[] = [];
  observed = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) {
    Observer.instances.push(this);
  }
  observe(row: Element) {
    this.observed.add(row);
  }
  unobserve(row: Element) {
    this.observed.delete(row);
  }
  disconnect() {
    this.observed.clear();
  }
  emit(row: Element, visible = true) {
    this.callback(
      [{ target: row, isIntersecting: visible } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}
const disposals: (() => void)[] = [];
const releases: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const raw = (marked = false) =>
  `---\ntype: article\n${marked ? 'bookmark: Words here\n' : ''}---\n${marked ? '==Words==' : 'Words'}`;
beforeEach(() => {
  Object.defineProperty(window, 'IntersectionObserver', { value: Observer, configurable: true });
  Observer.instances = [];
});
afterEach(async () => {
  disposals.splice(0).forEach((dispose) => dispose());
  releases.splice(0).forEach((release) => release());
  await flush();
  document.body.replaceChildren();
});
function fixture(slots = new IndicatorReadSlots()) {
  const list = document.createElement('div');
  document.body.append(list);
  const rows = [0, 1, 2].map(() => list.appendChild(document.createElement('button')));
  const files = new Map(
    rows.map((_, i) => [`${i}.md`, { path: `${i}.md`, stat: { mtime: 1, size: 1 } }]),
  );
  const bodies = new Map([...files.keys()].map((path) => [path, raw()]));
  const read = vi.fn(async (file: { path: string }) => bodies.get(file.path)!);
  const controller = new AbortController();
  const indicators = new RowIndicators(
    list,
    {
      file: (path) => files.get(path),
      read,
      signal: controller.signal,
      hostSignal: new AbortController().signal,
      active: () => true,
    },
    slots,
  );
  const mapping = new Map(rows.map((row, i) => [row, `${i}.md`]));
  indicators.update(mapping);
  disposals.push(indicators.dispose);
  return {
    list,
    rows,
    files,
    bodies,
    read,
    controller,
    indicators,
    mapping,
    slots,
    observer: Observer.instances.at(-1)!,
  };
}
it('reads only visible rows and refreshes added and removed evidence without new metadata', async () => {
  const f = fixture();
  expect(f.read).not.toHaveBeenCalled();
  f.observer.emit(f.rows[0]);
  await flush();
  expect(f.rows[0].querySelectorAll('.reader-row-indicator')).toHaveLength(0);
  f.bodies.set('0.md', raw(true));
  f.indicators.invalidate('0.md');
  await flush();
  expect(f.rows[0].querySelectorAll('.reader-row-indicator')).toHaveLength(2);
  f.observer.emit(f.rows[0]);
  await flush();
  expect(f.read).toHaveBeenCalledTimes(2);
  f.bodies.set('0.md', raw());
  f.indicators.invalidate('0.md');
  await flush();
  expect(f.rows[0].querySelectorAll('.reader-row-indicator')).toHaveLength(0);
  f.indicators.invalidate('1.md');
  await flush();
  expect(f.read).toHaveBeenCalledTimes(3);
  f.observer.emit(f.rows[1]);
  await flush();
  expect(f.read).toHaveBeenCalledTimes(4);
});
it('rejects in-flight stale evidence even with identical stats, then reads the latest revision', async () => {
  const f = fixture(),
    held = gate();
  releases.push(held.resolve);
  f.read.mockImplementationOnce(async () => {
    await held.promise;
    return raw(true);
  });
  f.observer.emit(f.rows[0]);
  f.indicators.invalidate('0.md');
  held.resolve();
  await flush();
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.rows[0].querySelectorAll('.reader-row-indicator')).toHaveLength(0);
});
it('does not reuse an old revision when the same row is removed and registered again', async () => {
  const f = fixture(),
    held = gate();
  releases.push(held.resolve);
  f.read.mockImplementationOnce(async () => {
    await held.promise;
    return raw(true);
  });
  const row = f.rows[0];
  f.observer.emit(row);
  f.mapping.delete(row);
  f.indicators.update(f.mapping);
  f.mapping.set(row, '0.md');
  f.indicators.update(f.mapping);
  f.observer.emit(row);
  held.resolve();
  await flush();
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(row.querySelectorAll('.reader-row-indicator')).toHaveLength(0);
});
it('keeps a shared two-read ceiling across replacement list mounts', async () => {
  const slots = new IndicatorReadSlots(),
    old = fixture(slots),
    holds = [gate(), gate()];
  holds.forEach((hold) => releases.push(hold.resolve));
  old.read
    .mockImplementationOnce(async () => {
      await holds[0].promise;
      return raw(true);
    })
    .mockImplementationOnce(async () => {
      await holds[1].promise;
      return raw(true);
    });
  old.rows.forEach((row) => old.observer.emit(row));
  expect(old.read).toHaveBeenCalledTimes(2);
  old.indicators.dispose();
  const next = fixture(slots);
  next.observer.emit(next.rows[0]);
  expect(next.read).not.toHaveBeenCalled();
  expect(slots.active).toBe(2);
  holds[0].resolve();
  await flush();
  expect(next.read).toHaveBeenCalledTimes(1);
  expect(slots.active).toBe(1);
  expect(old.rows[0].querySelectorAll('.reader-row-indicator')).toHaveLength(0);
  holds[1].resolve();
  await flush();
  expect(slots.active).toBe(0);
});
it('rejects replaced files and detached rows and stops cleanly on abort', async () => {
  const f = fixture(),
    held = gate();
  releases.push(held.resolve);
  f.read.mockImplementationOnce(async () => {
    await held.promise;
    return raw(true);
  });
  f.observer.emit(f.rows[0]);
  f.files.set('0.md', { path: '0.md', stat: { mtime: 1, size: 1 } });
  f.indicators.invalidate('0.md');
  held.resolve();
  await flush();
  expect(f.rows[0].querySelectorAll('.reader-row-indicator')).toHaveLength(0);
  f.mapping.delete(f.rows[0]);
  f.indicators.update(f.mapping);
  expect(f.observer.observed.has(f.rows[0])).toBe(false);
  f.controller.abort();
  f.indicators.dispose();
  f.observer.emit(f.rows[1]);
  await flush();
  expect(f.slots.active).toBe(0);
});
it('does not loop on failed reads and preserves completed rows when new rows are added', async () => {
  const f = fixture();
  f.read.mockRejectedValueOnce(new Error('Unavailable'));
  f.observer.emit(f.rows[0]);
  await flush();
  expect(f.read).toHaveBeenCalledTimes(1);
  f.indicators.invalidate('0.md');
  await flush();
  expect(f.read).toHaveBeenCalledTimes(2);
  const row = f.list.appendChild(document.createElement('button'));
  f.mapping.set(row, '1.md');
  f.indicators.update(f.mapping);
  f.observer.emit(f.rows[0]);
  await flush();
  expect(f.read).toHaveBeenCalledTimes(2);
  f.observer.emit(row);
  await flush();
  expect(f.read).toHaveBeenCalledTimes(3);
});
