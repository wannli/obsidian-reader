// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { renderBody } from '../src/reader/render';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const root = document.createElement('article');
  document.body.append(root);
  dispose = renderBody(
    '[![Diagram](https://example.com/image.png)](https://example.com)',
    root,
    'https://example.com',
  );
  return { root, image: root.querySelector('img')! };
}
it('opens loaded images by keyboard, traps focus, dismisses and restores focus without scrolling', () => {
  const { root, image } = setup();
  root.scrollTop = 123;
  image.focus();
  const focus = vi.spyOn(image, 'focus');
  image.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const dialog = document.querySelector('dialog')!;
  expect(dialog.getAttribute('aria-label')).toBe('Diagram');
  expect(dialog.querySelector('img')?.referrerPolicy).toBe('no-referrer');
  expect(dialog.querySelector('img')?.src).toBe(image.src);
  const enlarged = dialog.querySelector('img')!;
  expect(dialog.querySelector('button')).toBeNull();
  expect(dialog.children).toHaveLength(1);
  expect(enlarged.getAttribute('role')).toBe('button');
  expect(enlarged.getAttribute('aria-label')).toBe('Close image: Diagram');
  expect(document.activeElement).toBe(enlarged);
  for (const shiftKey of [false, true]) {
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }));
    expect(document.activeElement).toBe(enlarged);
  }
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.activeElement).toBe(image);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(root.scrollTop).toBe(123);
});
it('intercepts linked image clicks and supports close and disposal', () => {
  const { root, image } = setup();
  const navigate = vi.fn((event: Event) => event.preventDefault());
  root.parentElement!.addEventListener('click', navigate);
  image.click();
  expect(navigate).not.toHaveBeenCalled();
  document.querySelector<HTMLImageElement>('dialog img')!.click();
  expect(document.querySelector('dialog')).toBeNull();
  image.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  expect(document.querySelector('dialog')).not.toBeNull();
  dispose!();
  expect(document.querySelector('dialog')).toBeNull();
  image.click();
  expect(document.querySelector('dialog')).toBeNull();
});
it.each(['Enter', ' '])('closes the enlarged image with %j without propagating the key', (key) => {
  const { image } = setup();
  image.click();
  const enlarged = document.querySelector<HTMLImageElement>('dialog img')!;
  const outside = vi.fn();
  document.body.addEventListener('keydown', outside, { once: true });
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  enlarged.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(outside).not.toHaveBeenCalled();
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.activeElement).toBe(image);
  document.body.removeEventListener('keydown', outside);
});
it.each(['Enter', ' '])('does not toggle repeatedly while holding %j', (key) => {
  const { image } = setup();
  image.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, repeat: true }));
  expect(document.querySelector('dialog')).toBeNull();
  image.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  const dialog = document.querySelector('dialog')!;
  dialog
    .querySelector('img')!
    .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, repeat: true }));
  expect(document.querySelector('dialog')).toBe(dialog);
});
it('dismisses backdrop taps without leaking the click to the host', () => {
  const { image } = setup();
  image.click();
  const outside = vi.fn();
  document.body.addEventListener('click', outside, { once: true });
  document.querySelector('dialog')!.click();
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.activeElement).toBe(image);
  expect(outside).not.toHaveBeenCalled();
  document.body.removeEventListener('click', outside);
});
it('does not bypass lazy loading or retry a failed URL', () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const { image } = setup();
  image.click();
  expect(document.querySelector('dialog')).toBeNull();
  expect(image.hasAttribute('src')).toBe(false);
});
it('does not enlarge failed images and handles native dialog cancellation', () => {
  const { image } = setup();
  image.click();
  document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(document.activeElement).toBe(image);
  image.dispatchEvent(new Event('error'));
  image.click();
  expect(document.querySelector('dialog')).toBeNull();
});
