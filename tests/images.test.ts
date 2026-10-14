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
  expect(document.activeElement).toBe(dialog.querySelector('button'));
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(document.activeElement).toBe(dialog.querySelector('button'));
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
  document.querySelector<HTMLButtonElement>('dialog button')!.click();
  expect(document.querySelector('dialog')).toBeNull();
  image.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  expect(document.querySelector('dialog')).not.toBeNull();
  dispose!();
  expect(document.querySelector('dialog')).toBeNull();
  image.click();
  expect(document.querySelector('dialog')).toBeNull();
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
