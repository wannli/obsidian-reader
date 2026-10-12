import { afterEach, expect, it, vi } from 'vitest';
import { mountReader } from '../src/ui/reader';
import type { Article } from '../src/types';
import type { ReaderController } from '../src/controller';
const pages = vi.hoisted(() => ({ current: 0, change: () => {} }));
vi.mock('../src/ui/eink-pagination', () => ({ createEinkPagination: (_scroll: HTMLElement, _page: HTMLElement, _body: HTMLElement, options: { onChange(): void }) => {
  pages.current = 0; pages.change = options.onChange;
  return {
    turn(delta: number) { const next = Math.max(0, Math.min(2, pages.current + delta)); if (next === pages.current) return false; pages.current = next; options.onChange(); return true; },
    progress: () => ({ page: pages.current + 1, total: 3, ready: true }),
    getPosition: () => ({ marker: '' }), restore: () => options.onChange(), refresh() {}, dispose() {},
  };
} }));
const stops: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture(mobile = true, reverse = false) {
  const root = document.createElement('div'); document.body.append(root);
  const setChromeHidden = vi.fn();
  const article: Article = { path: 'Reading/Inbox/Test.md', title: 'Test', body: 'Readable text.', highlights: [], url: '', status: 'inbox', content: 'ready', extractor: 'manual' };
  const controller = { settings: {}, repository: { articleGeneration: () => 0, saveReadingPosition: vi.fn(async () => {}) } } as unknown as ReaderController;
  const mount = mountReader(root, article, controller, { openNote() {}, isMobile: mobile, shouldFocus: () => true,
    einkEnabled: () => true, reversePageButtons: () => reverse, setChromeHidden }, () => {});
  stops.push(mount);
  const press = (key: string) => {
    root.querySelector('.r2-reader-scroll')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    root.querySelector('.r2-reader-scroll')!.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  };
  return { root, setChromeHidden, mount, press };
}
it.each([false, true])('only successful explicit page turns alter chrome (reversed=%s)', reverse => {
  const f = fixture(true, reverse), next = reverse ? 'PageUp' : 'PageDown', previous = reverse ? 'PageDown' : 'PageUp';
  f.press(previous); expect(f.setChromeHidden).toHaveBeenLastCalledWith(false);
  f.press(next); expect(pages.current).toBe(1); expect(f.setChromeHidden).toHaveBeenLastCalledWith(true);
  f.press(next); expect(pages.current).toBe(2);
  f.root.querySelector<HTMLButtonElement>('.r2-reveal-chrome')!.click();
  f.press(next); expect(f.setChromeHidden).toHaveBeenLastCalledWith(false);
  pages.change(); f.mount.restorePosition!({ marker: '' }); expect(f.setChromeHidden).toHaveBeenLastCalledWith(false);
  f.press(previous); expect(pages.current).toBe(1); expect(f.setChromeHidden).toHaveBeenLastCalledWith(false);
  f.press(next); expect(f.setChromeHidden).toHaveBeenLastCalledWith(true);
  f.press(previous); expect(f.setChromeHidden).toHaveBeenLastCalledWith(false);
});
it('desktop mounts never acquire chrome or add a reveal control', () => {
  const f = fixture(false); f.press('PageDown');
  expect(pages.current).toBe(1); expect(f.setChromeHidden).not.toHaveBeenCalled(); expect(f.root.querySelector('.r2-reveal-chrome')).toBeNull();
});
