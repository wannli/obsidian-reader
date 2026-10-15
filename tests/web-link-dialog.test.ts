// @vitest-environment node
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { confirmArticleReplacement, confirmWebLink } from '../src/host/dialogs';

const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));

const state = vi.hoisted(() => ({ modal: undefined as any }));
vi.mock('obsidian', () => ({
  FuzzySuggestModal: class {},
  Modal: class {
    contentEl = Object.assign(document.createElement('div'), {
      createEl(this: HTMLElement, tag: string, options: any = {}) {
        const node = document.createElement(tag);
        node.textContent = options.text ?? '';
        this.append(node);
        return node;
      },
      empty(this: HTMLElement) {
        this.replaceChildren();
      },
    });
    constructor() {
      state.modal = this;
    }
    setTitle() {}
    open() {
      document.body.append(this.contentEl);
      (this as any).onOpen();
    }
    close() {
      (this as any).onClose();
      this.contentEl.remove();
    }
  },
  Setting: class {
    constructor(private element: HTMLElement) {}
    addButton(build: (button: any) => void) {
      const element = document.createElement('button');
      this.element.append(element);
      const button = {
        setButtonText(text: string) {
          element.textContent = text;
          return button;
        },
        setCta() {
          return button;
        },
        setWarning() {
          return button;
        },
        setDisabled(value: boolean) {
          element.disabled = value;
          return button;
        },
        onClick(callback: () => void) {
          element.onclick = callback;
          return button;
        },
      };
      build(button);
      return this;
    }
  },
}));
const click = (label: string) =>
  [...document.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
beforeEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('warns about destructive article replacement, names the target, and Cancel does nothing', () => {
  const replace = vi.fn();
  confirmArticleReplacement(
    {} as App,
    'Reading/Inbox/Target.md',
    replace,
    new AbortController().signal,
  );
  expect(document.body.textContent).toContain('Reading/Inbox/Target.md');
  expect(document.body.textContent).toContain('including all highlights and inline links');
  click('Cancel');
  expect(replace).not.toHaveBeenCalled();
});

it('only confirms replacement once and cancellation aborts an in-flight download', () => {
  const replace = vi.fn((_signal: AbortSignal) => new Promise<void>(() => {}));
  confirmArticleReplacement({} as App, 'Target.md', replace, new AbortController().signal);
  click('Replace content');
  click('Replace content');
  expect(replace).toHaveBeenCalledOnce();
  click('Cancel');
  expect(replace.mock.calls[0]![0].aborted).toBe(true);
});

it('closes replacement confirmation on generation retirement and disables stale buttons', () => {
  const generation = new AbortController(),
    replace = vi.fn();
  confirmArticleReplacement({} as App, 'Target.md', replace, generation.signal);
  const button = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Replace content',
  )!;
  generation.abort();
  button.click();
  expect(replace).not.toHaveBeenCalled();
  expect(document.querySelector('button')).toBeNull();
});

it('offers Save to Inbox, Open link, Cancel; Cancel performs no action', () => {
  const save = vi.fn(),
    open = vi.spyOn(window, 'open').mockReturnValue(null);
  confirmWebLink({} as App, 'https://example.test/', save, []);
  expect([...document.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
    'Cancel',
    'Open link',
    'Save to Inbox',
  ]);
  click('Cancel');
  expect(save).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it('opens only on explicit Open link, without saving', () => {
  const save = vi.fn(),
    open = vi.spyOn(window, 'open').mockReturnValue(null);
  confirmWebLink({} as App, 'https://example.test/', save, []);
  click('Open link');
  expect(open).toHaveBeenCalledWith('https://example.test/', '_blank', 'noopener,noreferrer');
  expect(save).not.toHaveBeenCalled();
});

it('prevents repeated saves and aborts pending work on Cancel', () => {
  const save = vi.fn(() => new Promise<void>(() => {}));
  confirmWebLink({} as App, 'https://example.test/', save, []);
  click('Save to Inbox');
  click('Save to Inbox');
  expect(save).toHaveBeenCalledOnce();
  click('Cancel');
  expect((save.mock.calls[0] as unknown as [AbortSignal])[0].aborted).toBe(true);
});

it('shows failures and allows retry without opening the URL', async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error('Write failed'))
    .mockResolvedValue(undefined);
  confirmWebLink({} as App, 'https://example.test/', save, []);
  click('Save to Inbox');
  await Promise.resolve();
  expect(document.body.textContent).toContain('Write failed');
  click('Save to Inbox');
  await Promise.resolve();
  expect(save).toHaveBeenCalledTimes(2);
  expect(document.querySelector('button')).toBeNull();
});

it.each([0, 1])('closes and disables stale callbacks when lifetime %s ends', (index) => {
  const signals = [new AbortController(), new AbortController()];
  const save = vi.fn(),
    open = vi.spyOn(window, 'open').mockReturnValue(null);
  confirmWebLink(
    {} as App,
    'https://example.test/',
    save,
    signals.map((signal) => signal.signal),
  );
  const buttons = [...document.querySelectorAll('button')];
  signals[index].abort();
  for (const button of buttons) button.click();
  expect(save).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(document.querySelector('button')).toBeNull();
});
