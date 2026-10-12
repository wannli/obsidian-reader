import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nativeReadingChrome, watchReadingChrome } from '../src/ui/reading-chrome';

let frames: FrameRequestCallback[], resize: () => void, cleanup: (() => void)[];
beforeEach(() => {
  frames = []; cleanup = []; document.body.replaceChildren();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
});
afterEach(() => { cleanup.forEach(stop => stop()); document.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function settle() { for (let i = 0; i < 4; i++) { const batch = frames.splice(0); batch.forEach(callback => callback(0)); } }
function fixture() {
  const shell = document.createElement('div'), scroll = document.createElement('div'); shell.append(scroll); document.body.append(shell);
  let active = true, changed = () => {};
  const setHidden = vi.fn();
  const chrome = watchReadingChrome(scroll, shell, { active: () => active, setHidden,
    onActiveChange: callback => { changed = callback; return vi.fn(); } });
  cleanup.push(() => chrome.dispose());
  const scrollTo = (top: number) => { scroll.scrollTop = top; scroll.dispatchEvent(new Event('scroll')); };
  const wheel = (delta: number) => scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: delta }));
  return { shell, scroll, chrome, setHidden, scrollTo, wheel, active(value: boolean) { active = value; changed(); } };
}
it('hides after downward intent and threshold, reveals upward; ignores restore and resize feedback', () => {
  const f = fixture(); f.scrollTo(100); expect(f.setHidden).toHaveBeenLastCalledWith(false);
  f.wheel(1); f.scrollTo(105); expect(f.setHidden).toHaveBeenLastCalledWith(false);
  f.scrollTo(120); expect(f.setHidden).toHaveBeenLastCalledWith(true);
  f.scrollTo(80); expect(f.setHidden).toHaveBeenLastCalledWith(true); settle();
  resize(); f.wheel(-30); f.scrollTo(40); settle(); expect(f.setHidden).toHaveBeenLastCalledWith(true);
  f.wheel(-30); f.scrollTo(20); expect(f.setHidden).toHaveBeenLastCalledWith(false);
});
it('explicit page direction works without scroll; escape and visible button always reveal', () => {
  const f = fixture(); f.chrome.turn(1); expect(f.setHidden).toHaveBeenLastCalledWith(true);
  expect(f.shell.querySelector('button')!.hidden).toBe(false);
  f.shell.querySelector('button')!.click(); expect(f.setHidden).toHaveBeenLastCalledWith(false);
  f.chrome.turn(1); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(f.setHidden).toHaveBeenLastCalledWith(false);
  f.chrome.turn(1); f.chrome.turn(-1); expect(f.setHidden).toHaveBeenLastCalledWith(false);
});
it('does not hide during selection, editing, dialogs, or inactive reading', () => {
  const f = fixture(); f.scroll.textContent = 'selected text';
  const range = document.createRange(); range.selectNodeContents(f.scroll); document.getSelection()!.addRange(range);
  f.chrome.turn(1); expect(f.setHidden).toHaveBeenLastCalledWith(false); document.getSelection()!.removeAllRanges();
  const input = document.createElement('input'); f.shell.append(input); input.focus();
  f.chrome.turn(1); expect(f.setHidden).toHaveBeenLastCalledWith(false); input.blur();
  const modal = document.createElement('div'); modal.className = 'modal-container'; document.body.append(modal);
  vi.spyOn(modal, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  f.chrome.turn(1); expect(f.setHidden).toHaveBeenLastCalledWith(false); modal.remove();
  f.chrome.turn(1); f.active(false); expect(f.setHidden).toHaveBeenLastCalledWith(false);
  f.chrome.turn(1); expect(f.setHidden).toHaveBeenLastCalledWith(false);
});
it('disposes listeners and reveal control and releases hidden state', () => {
  const f = fixture(); f.chrome.turn(1); f.chrome.dispose(); const calls = f.setHidden.mock.calls.length;
  expect(f.shell.querySelector('button')).toBeNull(); expect(f.setHidden).toHaveBeenLastCalledWith(false);
  f.wheel(20); f.scrollTo(40); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); settle();
  expect(f.setHidden).toHaveBeenCalledTimes(calls);
});
it('scopes headers, transfers shared chrome ownership, and restores classes on close', () => {
  document.body.innerHTML = '<div class="mobile-navbar"></div><div class="mobile-toolbar"></div>' +
    '<div class="workspace-leaf-content" data-type="reader"><div class="view-header"></div><main></main></div>'.repeat(2);
  const contents = [...document.querySelectorAll('main')]; let active = 0;
  const first = nativeReadingChrome(contents[0], () => active === 0), second = nativeReadingChrome(contents[1], () => active === 1);
  cleanup.push(first.dispose, second.dispose);
  first.setHidden(true); expect(document.querySelectorAll('.reader-chrome-hidden')).toHaveLength(3);
  expect(contents[1].parentElement!.querySelector('.view-header')!.className).toBe('view-header');
  active = 1; second.setHidden(true); first.setHidden(false);
  expect(document.querySelectorAll('.reader-chrome-hidden')).toHaveLength(3);
  expect(contents[0].parentElement!.querySelector('.view-header')!.className).toBe('view-header');
  second.dispose(); second.setHidden(true); expect(document.querySelectorAll('.reader-chrome-hidden, .reader-chrome-instant')).toHaveLength(0);
  active = -1; first.setHidden(true); expect(document.querySelectorAll('.reader-chrome-hidden')).toHaveLength(0);
});
it('reconciles replaced and inserted native chrome while hidden and stops after disposal', async () => {
  const f = fixture(), host = nativeReadingChrome(f.shell, () => true); cleanup.push(host.dispose);
  host.setHidden(true);
  const bar = document.createElement('div'); bar.className = 'mobile-navbar'; document.body.append(bar);
  await Promise.resolve(); expect(bar.classList.contains('reader-chrome-hidden')).toBe(true);
  const replacement = bar.cloneNode(false) as HTMLElement; replacement.className = 'mobile-navbar'; bar.replaceWith(replacement);
  await Promise.resolve(); expect(replacement.classList.contains('reader-chrome-hidden')).toBe(true);
  expect(bar.className).toBe('mobile-navbar'); host.dispose();
  replacement.replaceWith(bar); await Promise.resolve(); expect(bar.className).toBe('mobile-navbar');
});
it('ignores hidden menus but blocks visible menus', () => {
  const f = fixture(), menu = document.createElement('div'); menu.className = 'menu'; menu.style.display = 'none'; document.body.append(menu);
  f.chrome.turn(1); expect(f.setHidden).toHaveBeenLastCalledWith(true); f.chrome.turn(-1);
  menu.style.display = ''; vi.spyOn(menu, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  f.chrome.turn(1); expect(f.setHidden).toHaveBeenLastCalledWith(false);
});
it('tracks touch scroll direction without treating a touch tap as scrolling', () => {
  const f = fixture();
  const touch = (name: string, y: number) => {
    const event = new Event(name); Object.defineProperty(event, 'touches', { value: [{ clientY: y }] }); f.scroll.dispatchEvent(event);
  };
  touch('touchstart', 200); f.scrollTo(40); expect(f.setHidden).toHaveBeenLastCalledWith(false);
  touch('touchmove', 100); f.scrollTo(100); expect(f.setHidden).toHaveBeenLastCalledWith(true); settle();
  touch('touchstart', 100); touch('touchmove', 160); f.scrollTo(40); expect(f.setHidden).toHaveBeenLastCalledWith(false);
});
it('shift-space reveals; modified, composing and prevented keyboard events supply no intent', () => {
  const f = fixture(); f.chrome.turn(1); settle(); f.scrollTo(100);
  f.scroll.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true }));
  f.scrollTo(60); expect(f.setHidden).toHaveBeenLastCalledWith(false); settle();
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    f.scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, ...extra }));
    f.scrollTo(f.scroll.scrollTop + 20); expect(f.setHidden).toHaveBeenLastCalledWith(false);
  }
  const event = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }); event.preventDefault(); f.scroll.dispatchEvent(event);
  f.scrollTo(200); expect(f.setHidden).toHaveBeenLastCalledWith(false);
});
