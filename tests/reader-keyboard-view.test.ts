// @vitest-environment node
import { mocks, hostFixture, enableHighlightHost, actionName } from './helpers/reader-view-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform, setTooltip } from 'obsidian';
import { createDocument, patchProperties } from '../src/core/document';
import { ReaderView } from '../src/reader/view';
import * as surfaceModule from '../src/reader/surface';

describe('desktop button shortcuts', () => {
  const press = (view: ReaderView, key: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, cancelable: true, ...options });
    view.key(event);
    return event;
  };
  it('routes article and list letters through visible buttons only', async () => {
    const f = hostFixture();
    const a = await f.note('Reading/Inbox/A.md');
    const b = await f.note('Reading/Inbox/B.md');
    await f.note('Reading/Inbox/C.md');
    await f.view.openArticle(b.path, true);
    expect(press(f.view, 'k').defaultPrevented).toBe(true);
    await f.probe.operations;
    expect(f.view.file).toBe(a);
    expect(press(f.view, 'b').defaultPrevented).toBe(true);
    await f.probe.operations;
    expect(f.view.contentEl.querySelector('.reader-list')).not.toBeNull();
    for (const key of ['f', 'l', 'i']) expect(press(f.view, key).defaultPrevented).toBe(true);
    expect(press(f.view, 'a').defaultPrevented).toBe(false);
    const capture = vi.spyOn(f.host, 'capture');
    expect(press(f.view, 'u').defaultPrevented).toBe(true);
    expect(capture).toHaveBeenCalledOnce();
  });
  it('moves a visible list cursor, opens with Enter and restores the row with q', async () => {
    const f = hostFixture();
    const first = await f.note('Reading/Inbox/A.md');
    const second = await f.note('Reading/Inbox/B.md');
    await f.note('Reading/Inbox/C.md');
    f.view.showList();
    const rows = () => [
      ...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-list-item'),
    ];
    expect(rows()[0].classList.contains('reader-list-selected')).toBe(true);
    expect(press(f.view, 'j').defaultPrevented).toBe(true);
    expect(rows()[1].getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(rows()[1]);
    expect(press(f.view, 'Enter').defaultPrevented).toBe(true);
    await f.probe.operations;
    expect(f.view.file).toBe(second);
    expect(press(f.view, 'q').defaultPrevented).toBe(true);
    await f.probe.operations;
    expect(f.view.file).toBeUndefined();
    expect(document.activeElement).toBe(rows()[1]);
    expect(
      f.view.contentEl.querySelector('.reader-list-item.reader-list-selected')?.textContent,
    ).toContain('B');
    expect(press(f.view, 'k').defaultPrevented).toBe(true);
    expect(rows()[0].getAttribute('aria-current')).toBe('true');
    expect(first.path).toContain('A.md');
  });
  it('uses gg/G on rendered rows only and shows a scoped shortcut sheet', async () => {
    const f = hostFixture();
    for (let index = 0; index < 55; index++)
      await f.note(`Reading/Inbox/${String(index).padStart(2, '0')}.md`);
    f.view.showList();
    const rows = () => [
      ...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-list-item'),
    ];
    expect(rows()).toHaveLength(50);
    expect(press(f.view, 'G', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(rows()[49].classList.contains('reader-list-selected')).toBe(true);
    expect(press(f.view, 'g').defaultPrevented).toBe(true);
    expect(press(f.view, 'g').defaultPrevented).toBe(true);
    expect(rows()[0].classList.contains('reader-list-selected')).toBe(true);
    expect(press(f.view, '?', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(f.view.contentEl.querySelector('[role="dialog"]')?.textContent).toContain(
      'First / last visible row',
    );
    expect(press(f.view, 'j').defaultPrevented).toBe(true);
    expect(rows()[0].classList.contains('reader-list-selected')).toBe(true);
    expect(press(f.view, 'Escape').defaultPrevented).toBe(true);
    expect(f.view.contentEl.querySelector('[role="dialog"]')).toBeNull();
  });
  it('moves within an article without mapping d to Delete or Space to next article', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md', 'Long article content');
    await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(article.path, true);
    const move = vi.spyOn(f.probe.surface, 'moveByPage');
    const jump = vi.spyOn(f.probe.surface, 'jumpTo');
    for (const [key, direction, fraction] of [
      ['d', 1, 0.5],
      ['u', -1, 0.5],
      [' ', 1, 1],
    ] as const) {
      expect(press(f.view, key).defaultPrevented).toBe(true);
      expect(move).toHaveBeenLastCalledWith(direction, fraction);
    }
    expect(press(f.view, ' ', { repeat: true }).defaultPrevented).toBe(true);
    expect(move).toHaveBeenCalledTimes(3);
    expect(press(f.view, 'g').defaultPrevented).toBe(true);
    expect(press(f.view, 'g').defaultPrevented).toBe(true);
    expect(jump).toHaveBeenCalledWith(-1);
    expect(press(f.view, 'G', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(jump).toHaveBeenCalledWith(1);
    expect(f.view.contentEl.querySelector('[data-reader-key="d"]')).toBeNull();
    expect(f.view.file).toBe(article);
    expect(press(f.view, '?', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(f.view.contentEl.querySelector('[role="dialog"]')?.textContent).toContain(
      'Full page down',
    );
    expect(press(f.view, 'Tab').defaultPrevented).toBe(false);
    expect(document.activeElement?.textContent).toBe('Close shortcuts');
    expect(press(f.view, 'Escape').defaultPrevented).toBe(true);
    const button = f.view.contentEl.querySelector<HTMLButtonElement>('.reader-actions button')!;
    button.focus();
    expect(press(f.view, 'd').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(press(f.view, ' ').defaultPrevented).toBe(false);
    const outside = document.body.appendChild(document.createElement('button'));
    outside.focus();
    const event = new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true });
    outside.addEventListener('keydown', (e) => f.view.key(e), { once: true });
    outside.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  it('routes numbered contextual destinations to the visible matching button', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path, true);
    const button = f.view.contentEl
      .querySelector<HTMLElement>('.reader-actions')!
      .appendChild(document.createElement('button'));
    button.dataset.readerKey = '1';
    const click = vi.spyOn(button, 'click');
    expect(press(f.view, '1').defaultPrevented).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });
  it('opens the status picker with S without changing status on cancellation', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path, true);
    const button = f.view.contentEl.querySelector<HTMLButtonElement>(
      '.reader-actions button[data-reader-key="s"]',
    )!;
    expect(button.getAttribute('aria-keyshortcuts')).toBe('S');
    expect(button.hasAttribute('title')).toBe(false);
    expect(setTooltip).toHaveBeenCalledWith(
      button,
      'Change status and advance · S: choose · L: Later · A: Archive',
    );
    mocks.choose.mockResolvedValueOnce(null);
    expect(press(f.view, 's').defaultPrevented).toBe(true);
    expect(mocks.choose).toHaveBeenCalledOnce();
    expect(mocks.choose.mock.calls[0][2]).toEqual(['Later', 'Feed', 'Archive']);
    expect(f.view.file).toBe(article);
    expect((await f.store.read(article.path)).properties.status).toBe('inbox');
  });
  it.each([
    ['l', 'Later', 'later'],
    ['a', 'Archive', 'archive'],
  ] as const)(
    '%s chooses %s directly and advances rather than opening the picker',
    async (key, destination, savedStatus) => {
      const f = hostFixture();
      const first = await f.note('Reading/Inbox/A.md');
      const next = await f.note('Reading/Inbox/B.md');
      await f.view.openArticle(first.path, true);
      expect(press(f.view, key).defaultPrevented).toBe(true);
      await f.probe.operations;
      expect(f.view.file).toBe(next);
      expect(first.path).toBe(`Reading/${destination === 'Later' ? 'Later' : 'Treasury'}/A.md`);
      expect((await f.store.read(first.path)).properties.status).toBe(savedStatus);
      expect(mocks.choose).not.toHaveBeenCalled();
      expect(f.store.catalog.article(first.path)?.status).toBe(savedStatus);
    },
  );
  it('moves directly from the command palette without a picker or advancing', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md');
    await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(article.path, true);
    expect(f.view.articleCommand('move', true, 'Later')).toBe(true);
    expect(article.path).toBe('Reading/Inbox/A.md');
    expect(f.view.articleCommand('move', false, 'Later')).toBe(true);
    await f.probe.operations;
    expect(f.view.file).toBe(article);
    expect(article.path).toBe('Reading/Later/A.md');
    expect(mocks.choose).not.toHaveBeenCalled();
  });
  it('guards repeats, mobile, modifiers and typing', async () => {
    const f = hostFixture();
    const b = await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(b.path, true);
    const archive = vi.spyOn(f.store, 'move');
    for (const options of [{ repeat: true }, { ctrlKey: true }, { shiftKey: true }])
      expect(press(f.view, 'a', options).defaultPrevented).toBe(false);
    Platform.isMobile = true;
    expect(press(f.view, 'a').defaultPrevented).toBe(false);
    Platform.isMobile = false;
    const input = document.body.appendChild(document.createElement('input'));
    const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
    input.addEventListener('keydown', (e) => f.view.key(e), { once: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(archive).not.toHaveBeenCalled();
  });
  it('does not navigate or change status through shortcuts while a dialog or selection is active', async () => {
    const f = hostFixture();
    const first = await f.note('Reading/Inbox/A.md', 'Article content');
    await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(first.path, true);
    const move = vi.spyOn(f.store, 'move');
    f.probe.dialog = true;
    for (const key of ['j', 'k', 'l', 'a']) expect(press(f.view, key).defaultPrevented).toBe(false);
    f.probe.dialog = false;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(
      f.probe.surface.body.appendChild(document.createTextNode('select me')),
    );
    selection.addRange(range);
    for (const key of ['j', 'k', 'l', 'a']) expect(press(f.view, key).defaultPrevented).toBe(false);
    selection.removeAllRanges();
    expect(move).not.toHaveBeenCalled();
    expect(f.view.file).toBe(first);
  });
});

describe('article keyboard boundaries', () => {
  it.each(
    ['list', 'Next', 'Previous', 'PageDown', 'PageUp'].flatMap((route) =>
      [false, true].map((saved) => ({ route, saved })),
    ),
  )(
    'resumes saved position without direction overrides via $route (saved=$saved)',
    async ({ route, saved }) => {
      const f = hostFixture();
      const a = await f.note('Reading/Inbox/A.md'),
        b = await f.note('Reading/Inbox/B.md');
      for (const file of [a, b]) {
        f.vault.bytes.set(
          file,
          patchProperties(f.vault.bytes.get(file)!, {
            bookmark: saved ? `Saved text from ${file.path}` : undefined,
          }),
        );
      }
      const previous = route === 'Previous' || route === 'PageUp',
        target = previous ? a : b;
      f.host.paged = true;
      await f.view.openArticle((previous ? b : a).path, true);
      if (route === 'list') {
        await f.view.readingList();
        [...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-list-item')]
          .find((row) => row.textContent === 'B')!
          .click();
      } else if (route === 'Next' || route === 'Previous') {
        const key = new KeyboardEvent('keydown', {
          key: route === 'Next' ? 'j' : 'k',
          cancelable: true,
        });
        f.view.key(key);
        expect(key.defaultPrevented).toBe(true);
      } else {
        f.probe.surface.atBoundary.mockReturnValue(true);
        f.view.key(new KeyboardEvent('keydown', { key: route, cancelable: true }));
      }
      await f.probe.operations;
      expect(f.view.file).toBe(target);
      expect(f.probe.surface.restore).toHaveBeenLastCalledWith(
        saved ? `Saved text from ${target.path}` : '',
      );
    },
  );
  it.each([
    ['j', 'Next'],
    ['k', 'Previous'],
  ] as const)('uses %s for %s articles, never pages, in paged mode', async (key, label) => {
    const f = hostFixture();
    f.host.paged = true;
    const a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md'),
      c = await f.note('Reading/Inbox/C.md');
    await f.view.openArticle(b.path, true);
    f.probe.surface.atBoundary.mockReturnValue(false);
    f.probe.surface.canPage.mockReturnValue(true);
    expect(f.view.contentEl.querySelector(`[aria-label="${label} article"]`)).toBeNull();
    const event = new KeyboardEvent('keydown', { key, cancelable: true });
    f.view.key(event);
    expect(event.defaultPrevented).toBe(true);
    await f.probe.operations;
    expect(f.view.file).toBe(label === 'Next' ? c : a);
    expect(f.probe.surface.page).not.toHaveBeenCalled();
  });

  it('offers separate touch page controls that never navigate articles', async () => {
    const f = hostFixture();
    f.host.paged = true;
    const a = await f.note('Reading/Inbox/A.md');
    await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(a.path, true);
    const controls = () => [
      ...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button'),
    ];
    expect(controls().map(actionName).slice(0, 2)).toEqual(['Previous page', 'Next page']);
    expect(
      controls()
        .slice(0, 2)
        .map((button) => button.querySelector('svg')?.dataset.icon),
    ).toEqual(['chevron-up', 'chevron-down']);
    for (const [label, direction] of [
      ['Next page', 1],
      ['Previous page', -1],
    ] as const) {
      controls()
        .find((button) => actionName(button) === label)!
        .click();
      await f.probe.operations;
      expect(f.view.file).toBe(a);
      expect(f.probe.surface.page).toHaveBeenLastCalledWith(direction);
    }
  });

  it('keeps page controls in paged mode and refreshes without reopening', async () => {
    const f = hostFixture();
    f.host.paged = true;
    const a = await f.note('Reading/Inbox/A.md');
    await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(a.path, true);
    const surface = f.probe.surface;
    const column = f.view.contentEl.querySelector('.reader-article')!;
    const actions = column.querySelector('.reader-actions')!;
    const names = () => [...actions.querySelectorAll('button')].map(actionName);
    expect(names()).toEqual([
      'Previous page',
      'Next page',
      'Change status',
      'Delete',
      'List',
      'Highlight mode',
      'Link or create note',
      'Related notes',
    ]);
    expect(column.classList.contains('reader-has-page-actions')).toBe(true);
    expect(actions.classList.contains('reader-paged-actions')).toBe(true);
    actions.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click();
    expect(f.probe.surface.page).toHaveBeenCalledWith(1);
    expect(f.view.file).toBe(a);
    f.view.refreshArticleControls();
    expect(names().slice(0, 2)).toEqual(['Previous page', 'Next page']);
    expect(column.classList.contains('reader-has-page-actions')).toBe(true);
    expect(actions.classList.contains('reader-paged-actions')).toBe(true);
    expect(f.probe.surface).toBe(surface);
    f.view.refreshArticleControls();
    expect(names()).toHaveLength(8);
    expect(f.view.file).toBe(a);
    expect(f.probe.surface).toBe(surface);
  });

  it('disables Previous page at the first page even when there are other articles', async () => {
    const f = hostFixture();
    f.host.paged = true;
    const a = await f.note('Reading/Inbox/A.md');
    await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(a.path, true);
    f.probe.surface.atBoundary.mockReturnValue(true);
    f.view.refreshArticleControls();
    const button = [
      ...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button'),
    ].find((item) => actionName(item) === 'Previous page')!;
    expect(button.disabled).toBe(true);
  });

  async function fixture() {
    const f = hostFixture();
    const a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md'),
      c = await f.note('Reading/Inbox/C.md');
    await f.view.openArticle(b.path, true);
    f.probe.surface.atBoundary.mockReturnValue(true);
    return { ...f, a, b, c };
  }
  describe('real Surface arrow handoff', () => {
    let f: Awaited<ReturnType<typeof realFixture>>;
    const width = 366,
      height = 600,
      columns = 18,
      gap = 32;
    const extent = columns * width + (columns - 1) * gap;
    const maxLeft = extent - width; // 6766: the browser reproduction's reachable endpoint.
    async function realFixture() {
      const actual = await vi.importActual<typeof surfaceModule>('../src/reader/surface');
      const render = await import('../src/reader/render');
      // Only absent jsdom geometry/position capture is stubbed. Paging, boundaries,
      // rendering and the Reader key/navigation path remain production code.
      vi.spyOn(render, 'textBookmark').mockReturnValue('');
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
        },
      );
      vi.spyOn(surfaceModule, 'ReadingSurface').mockImplementation(function (...args) {
        const surface = new actual.ReadingSurface(...args);
        let left = 0;
        Object.defineProperties(surface.viewport, {
          clientWidth: { get: () => width },
          clientHeight: { get: () => height },
          scrollWidth: { get: () => extent },
          scrollHeight: { get: () => 1800 },
          scrollLeft: {
            get: () => left,
            set: (value: number) => {
              left = Math.max(0, Math.min(maxLeft, value));
            },
          },
        });
        Object.defineProperty(surface.flow, 'scrollWidth', { get: () => extent });
        return surface;
      });
      const f = hostFixture();
      f.host.paged = true;
      const a = await f.note('Reading/Inbox/A.md'),
        b = await f.note('Reading/Inbox/B.md'),
        c = await f.note('Reading/Inbox/C.md');
      await f.view.onOpen();
      await f.view.openArticle(b.path, true);
      return { ...f, a, b, c };
    }
    beforeEach(async () => {
      f = await realFixture();
    });
    afterEach(() => {
      f?.view.stopForUnload();
      vi.unstubAllGlobals();
    });

    it.each(['ArrowDown', 'ArrowUp'])(
      'aligns %s from four pixels short, rejects held-repeat handoff, then navigates once on a fresh press',
      async (key) => {
        const surface = f.probe.surface as surfaceModule.ReadingSurface;
        const direction = key === 'ArrowDown' ? 1 : -1;
        const end = direction === 1 ? maxLeft : 0;
        surface.viewport.scrollLeft = direction === 1 ? maxLeft - 4 : 4;
        expect(surface.atBoundary(direction)).toBe(false);
        expect(surface.canPage(direction)).toBe(false); // Keys must still finish the page.
        const step = new KeyboardEvent('keydown', { key, cancelable: true });
        f.view.key(step);
        await f.probe.operations;
        expect(surface.viewport.scrollLeft).toBe(end);
        expect(step.defaultPrevented).toBe(true);
        expect(f.view.file).toBe(f.b);
        expect(surface.atBoundary(direction)).toBe(true);
        f.view.key(new KeyboardEvent('keydown', { key, repeat: true }));
        await f.probe.operations;
        expect(f.view.file).toBe(f.b);
        const open = vi.spyOn(f.probe, 'openArticleNow');
        f.view.key(new KeyboardEvent('keydown', { key }));
        f.view.key(new KeyboardEvent('keydown', { key })); // No overlapping handoffs.
        await f.probe.operations;
        expect(f.view.file).toBe(direction === 1 ? f.c : f.a);
        expect(open).toHaveBeenCalledOnce();
        expect(f.vault.trashed).toEqual([]);
      },
    );

    it('preserves immediate Previous for ArrowUp already at the true boundary', async () => {
      const surface = f.probe.surface as surfaceModule.ReadingSurface;
      expect(surface.atBoundary(-1)).toBe(true);
      const page = vi.spyOn(surface, 'page');
      f.view.key(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      await f.probe.operations;
      expect(f.view.file).toBe(f.a);
      expect(page).not.toHaveBeenCalled();
    });

    it.each(['ArrowDown', 'ArrowUp'])('leaves flow-mode %s scrolling native', async (key) => {
      f.host.paged = false;
      await f.view.openArticle(f.b.path, true);
      const surface = f.probe.surface as surfaceModule.ReadingSurface;
      surface.viewport.scrollTop = 200;
      const page = vi.spyOn(surface, 'page');
      const event = new KeyboardEvent('keydown', { key, cancelable: true });
      f.view.key(event);
      await f.probe.operations;
      expect(event.defaultPrevented).toBe(false);
      expect(page).not.toHaveBeenCalled();
      expect(f.view.file).toBe(f.b);
    });

    it.each(
      ['ArrowDown', 'ArrowUp'].flatMap((key) =>
        ['input', 'modal', 'selection'].map((context) => ({ key, context })),
      ),
    )(
      'keeps $key paging behind the $context guard four pixels before the boundary',
      ({ key, context }) => {
        const surface = f.probe.surface as surfaceModule.ReadingSurface;
        const start = key === 'ArrowDown' ? maxLeft - 4 : 4;
        surface.viewport.scrollLeft = start;
        let target: HTMLElement = surface.body;
        if (context === 'input')
          target = document.body.appendChild(document.createElement('input'));
        if (context === 'modal') document.body.createDiv({ cls: 'modal-container' });
        if (context === 'selection') {
          const range = document.createRange();
          range.selectNodeContents(surface.body);
          document.getSelection()!.addRange(range);
        }
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        target.addEventListener('keydown', (event) => f.view.key(event), { once: true });
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(surface.viewport.scrollLeft).toBe(start);
        expect(f.view.file).toBe(f.b);
      },
    );
  });

  describe('confirmed paged endpoint', () => {
    // Chromium measurements, not a claim about the physical Boox's scale.
    const clamps = [
      { zoom: 0.25, width: 366, extent: 2356, end: 1988 },
      { zoom: 0.33, width: 366, extent: 2356, end: 1987.878662109375 },
      { zoom: 0.4, width: 341, extent: 2206, end: 1862.5 },
      { zoom: 0.6, width: 276, extent: 2124, end: 1846.6666259765625 },
    ];
    let f: Awaited<ReturnType<typeof measuredFixture>> | undefined;
    let restoreFonts: (() => void) | undefined;
    async function measuredFixture(sample = clamps[3]) {
      const actual = await vi.importActual<typeof surfaceModule>('../src/reader/surface');
      const render = await import('../src/reader/render');
      vi.spyOn(render, 'textBookmark').mockReturnValue('');
      const geometry = {
        ...sample,
        height: 600,
        renderedWidth: sample.width * sample.zoom,
        defer: false,
        probeMoves: false,
        onWrite: undefined as (() => void) | undefined,
      };
      const writes: { requested: number; before: number; after: number; behavior: string }[] = [];
      const resizeObservers = new Set<() => void>();
      const resize = () => {
        for (const notify of [...resizeObservers]) notify();
      };
      vi.stubGlobal(
        'ResizeObserver',
        class {
          private readonly notify: () => void;
          constructor(callback: ResizeObserverCallback) {
            this.notify = () => callback([], this as unknown as ResizeObserver);
            resizeObservers.add(this.notify);
          }
          observe() {}
          disconnect() {
            resizeObservers.delete(this.notify);
          }
        },
      );
      const fonts = new window.EventTarget();
      const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
      Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
      restoreFonts = () => {
        if (descriptor) Object.defineProperty(document, 'fonts', descriptor);
        else delete (document as any).fonts;
      };
      vi.spyOn(surfaceModule, 'ReadingSurface').mockImplementation(function (...args) {
        const surface = new actual.ReadingSurface(...args);
        let left = 0;
        surface.viewport.style.scrollSnapType = 'none';
        surface.viewport.style.direction = 'ltr';
        surface.flow.style.direction = 'ltr';
        Object.defineProperties(surface.viewport, {
          clientWidth: { get: () => geometry.width },
          clientHeight: { get: () => geometry.height },
          offsetWidth: { get: () => geometry.width },
          scrollWidth: { get: () => geometry.extent },
          scrollHeight: { get: () => geometry.height },
          scrollLeft: {
            configurable: true,
            get: () => left,
            set: (requested: number) => {
              const before = left;
              const stride = geometry.width + 32;
              const last = (Math.ceil((geometry.extent + 32) / stride) - 1) * stride;
              if (!geometry.defer) {
                const end = geometry.probeMoves && requested > last ? last + 4 : geometry.end;
                left = Math.max(0, Math.min(end, requested));
              }
              writes.push({
                requested,
                before,
                after: left,
                behavior: getComputedStyle(surface.viewport).scrollBehavior,
              });
              geometry.onWrite?.();
            },
          },
        });
        Object.defineProperty(surface.flow, 'scrollWidth', { get: () => geometry.extent });
        vi.spyOn(surface.viewport, 'getBoundingClientRect').mockImplementation(
          () => new DOMRect(10, 20, geometry.renderedWidth, geometry.height * geometry.zoom),
        );
        return surface;
      });
      const result = hostFixture();
      result.host.paged = true;
      const a = await result.note('Reading/Inbox/A.md');
      const b = await result.note('Reading/Inbox/B.md');
      const c = await result.note('Reading/Inbox/C.md');
      await result.view.onOpen();
      await result.view.openArticle(b.path, true);
      return {
        ...result,
        a,
        b,
        c,
        geometry,
        writes,
        fonts,
        resize: () => resize(),
        surface: result.probe.surface as surfaceModule.ReadingSurface,
      };
    }
    afterEach(() => {
      f?.view.stopForUnload();
      f = undefined;
      restoreFonts?.();
      restoreFonts = undefined;
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });
    it.each(
      clamps.flatMap((sample) => ['ArrowDown', 'PageDown'].map((key) => ({ ...sample, key }))),
    )(
      '$key aligns four reachable CSS pixels, then hands off once at zoom $zoom',
      async (sample) => {
        f = await measuredFixture(sample);
        const { surface, view, probe, geometry, writes } = f;
        surface.viewport.scrollLeft = geometry.end - 4;
        expect(surface.atBoundary(1)).toBe(false);
        view.key(new KeyboardEvent('keydown', { key: sample.key, cancelable: true }));
        await probe.operations;
        expect(surface.viewport.scrollLeft).toBe(geometry.end);
        expect(view.file).toBe(f.b); // Neither the page nor its probe may navigate this press.
        expect(surface.atBoundary(1)).toBe(true);
        expect(writes.at(-1)?.after).toBe(writes.at(-1)?.before);
        const stride = geometry.width + 32;
        const last = (Math.ceil((geometry.extent + 32) / stride) - 1) * stride;
        expect(writes.at(-1)!.requested - last).toBeGreaterThan(Math.ceil(1 / geometry.zoom));
        expect(writes.at(-1)!.requested - last).toBeLessThanOrEqual(stride);
        surface.viewport.scrollLeft = geometry.end - 1;
        expect(surface.atBoundary(1)).toBe(true);
        // Confirmed reachability never widens the ordinary one-CSS-pixel tolerance.
        surface.viewport.scrollLeft = geometry.end - 4;
        expect(surface.atBoundary(1)).toBe(false);
        surface.viewport.scrollLeft = geometry.end;
        view.key(new KeyboardEvent('keydown', { key: sample.key, repeat: true }));
        await probe.operations;
        expect(view.file).toBe(f.b);
        const open = vi.spyOn(probe, 'openArticleNow');
        view.key(new KeyboardEvent('keydown', { key: sample.key }));
        view.key(new KeyboardEvent('keydown', { key: sample.key }));
        await probe.operations;
        expect(view.file).toBe(f.c);
        expect(open).toHaveBeenCalledOnce();
      },
    );
    it('hands off PageDown after a fresh press at a visually confirmed device clamp beyond zoom tolerance', async () => {
      f = await measuredFixture({ zoom: 0.6, width: 276, extent: 2124, end: 1814 });
      const { surface, geometry, view, probe, writes } = f;
      const frame = surface.viewport.getBoundingClientRect();
      surface.body.append('\n'); // Rendered Markdown commonly has trailing whitespace.
      let visible = true;
      const rects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: function (this: Range) {
          if (this.startContainer.nodeType === Node.TEXT_NODE) return [];
          return [
            new DOMRect(visible ? frame.right - 40 : frame.right + 10, frame.bottom - 40, 20, 20),
          ];
        },
      });
      try {
        surface.viewport.scrollLeft = geometry.end - 4;
        expect(surface.atBoundary(1)).toBe(false);
        view.key(new KeyboardEvent('keydown', { key: 'PageDown' }));
        await probe.operations;
        expect(view.file).toBe(f.b); // The press that reaches the clamp never leaves.
        expect(surface.viewport.scrollLeft).toBe(geometry.end);
        expect(writes.at(-1)?.after).toBe(writes.at(-1)?.before);
        expect(surface.atBoundary(1)).toBe(true);
        visible = false;
        expect(surface.atBoundary(1)).toBe(false); // A changed tail invalidates visual proof.
        visible = true;
        view.key(new KeyboardEvent('keydown', { key: 'PageDown', repeat: true }));
        await probe.operations;
        expect(view.file).toBe(f.b);
        view.key(new KeyboardEvent('keydown', { key: 'PageDown' }));
        await probe.operations;
        expect(view.file).toBe(f.c);
        expect(f.vault.trashed).toEqual([]);
      } finally {
        if (rects) Object.defineProperty(Range.prototype, 'getClientRects', rects);
        else delete (Range.prototype as any).getClientRects;
      }
    });

    it('does not hand off when a clamped last-column request still leaves content offscreen', async () => {
      f = await measuredFixture({ zoom: 0.6, width: 276, extent: 2124, end: 1814 });
      const { surface, geometry, view, probe } = f;
      const frame = surface.viewport.getBoundingClientRect();
      const rects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: () => [new DOMRect(frame.right + 10, frame.bottom - 40, 20, 20)],
      });
      try {
        surface.viewport.scrollLeft = geometry.end;
        view.key(new KeyboardEvent('keydown', { key: 'PageDown' }));
        await probe.operations;
        expect(surface.atBoundary(1)).toBe(false);
        view.key(new KeyboardEvent('keydown', { key: 'PageDown' }));
        await probe.operations;
        expect(view.file).toBe(f.b);
      } finally {
        if (rects) Object.defineProperty(Range.prototype, 'getClientRects', rects);
        else delete (Range.prototype as any).getClientRects;
      }
    });

    it('retains the confirmed endpoint through actual position writes and delayed scroll capture', async () => {
      f = await measuredFixture();
      const render = await import('../src/reader/render');
      vi.mocked(render.textBookmark).mockReturnValue('before words');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { surface, geometry, view, probe, store } = f;
      surface.viewport.scrollLeft = geometry.end - 4;
      surface.page(1); // Capture dispatches the real View.persistPosition -> ArticleStore write.
      await probe.positionWrite;
      expect((await store.read(f.b.path)).properties.bookmark).toBe('before words');
      expect(surface.atBoundary(1)).toBe(true);
      const body = surface.body.firstChild;
      surface.viewport.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(300);
      await probe.positionWrite;
      expect(surface.body.firstChild).toBe(body);
      expect(surface.atBoundary(1)).toBe(true);
      await store.position(f.c.path, 'after');
      // Supply only jsdom's missing Range box; bookmark lookup and restoration stay real.
      const bounds = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => new DOMRect(10 + geometry.width + 32, 20, 40, 20),
      });
      try {
        view.key(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        await probe.operations;
        expect(view.file).toBe(f.c);
        expect(probe.surface.viewport.scrollLeft).toBe(geometry.width + 32);
        expect((await store.read(f.c.path)).properties.bookmark).toBe('after');
      } finally {
        if (bounds) Object.defineProperty(Range.prototype, 'getBoundingClientRect', bounds);
        else delete (Range.prototype as any).getBoundingClientRect;
      }
    });
    it.each(['selection', 'pointer', 'input', 'modal'])(
      'keeps the %s guard at a measured clamp',
      async (guard) => {
        f = await measuredFixture();
        const { surface, view, geometry } = f;
        surface.viewport.scrollLeft = geometry.end;
        let target: HTMLElement = surface.body;
        if (guard === 'selection') {
          const range = document.createRange();
          range.selectNodeContents(surface.body);
          document.getSelection()!.addRange(range);
        }
        if (guard === 'pointer') {
          const event = new MouseEvent('pointerdown', { bubbles: true, button: 0 });
          Object.defineProperty(event, 'pointerId', { value: 17 });
          surface.viewport.dispatchEvent(event);
        }
        if (guard === 'input') target = document.body.createEl('input');
        if (guard === 'modal') document.body.createDiv({ cls: 'modal-container' });
        const event = new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        });
        target.addEventListener('keydown', (event) => view.key(event), { once: true });
        target.dispatchEvent(event);
        await f.probe.operations;
        expect(view.file).toBe(f.b);
        expect(surface.atBoundary(1)).toBe(false);
      },
    );
    it.each(['smooth', 'auto'])(
      'forces instantaneous requests and restores inline %s priority',
      async (behavior) => {
        f = await measuredFixture();
        const { surface, geometry, writes } = f;
        surface.viewport.style.setProperty('scroll-behavior', behavior, 'important');
        surface.viewport.scrollLeft = geometry.end;
        writes.length = 0;
        surface.page(1);
        expect(writes.length).toBe(2);
        expect(writes.every((write) => write.behavior === 'auto')).toBe(true);
        expect(surface.viewport.style.getPropertyValue('scroll-behavior')).toBe(behavior);
        expect(surface.viewport.style.getPropertyPriority('scroll-behavior')).toBe('important');
        expect(surface.atBoundary(1)).toBe(true); // Restoring smooth must not invalidate the evidence.
      },
    );
    it('restores the previous scroll behavior even when a request throws', async () => {
      f = await measuredFixture();
      const { surface } = f;
      surface.viewport.style.setProperty('scroll-behavior', 'smooth', 'important');
      vi.spyOn(surface.viewport, 'scrollLeft', 'set').mockImplementation(() => {
        throw new Error('scroll failed');
      });
      expect(() => surface.page(1)).toThrow('scroll failed');
      expect(surface.viewport.style.getPropertyValue('scroll-behavior')).toBe('smooth');
      expect(surface.viewport.style.getPropertyPriority('scroll-behavior')).toBe('important');
    });
    it.each([
      'middle',
      'near-last-half-page',
      'rtl',
      'vertical',
      'snap',
      'unmeasured',
      'forced-smooth',
    ])('does not infer EOF from an ignored request with %s geometry', async (kind) => {
      f = await measuredFixture();
      const { surface, geometry } = f;
      if (kind !== 'middle' && kind !== 'rtl') surface.viewport.scrollLeft = geometry.end;
      if (kind === 'near-last-half-page') {
        surface.viewport.scrollLeft = geometry.end - (geometry.width + 32) * 0.4;
        expect(surface.canPage(1)).toBe(false);
      }
      geometry.defer = true;
      if (kind === 'rtl') surface.viewport.style.direction = 'rtl';
      if (kind === 'vertical') surface.flow.style.writingMode = 'vertical-rl';
      if (kind === 'snap') surface.viewport.style.scrollSnapType = 'x mandatory';
      if (kind === 'unmeasured') geometry.renderedWidth = 0;
      if (kind === 'forced-smooth') {
        const computed = window.getComputedStyle.bind(window);
        vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
          const style = computed(element, pseudo);
          if (element === surface.viewport)
            Object.defineProperty(style, 'scrollBehavior', { value: 'smooth' });
          return style;
        });
      }
      surface.page(1);
      expect(surface.atBoundary(1)).toBe(false);
    });
    it.each(['restoring', 'layoutPending', 'restorePending', 'index', 'next'])(
      'cannot learn while %s is unsettled',
      async (state) => {
        f = await measuredFixture();
        const { surface, geometry } = f;
        surface.viewport.scrollLeft = geometry.end;
        (surface as any)[state] =
          state === 'index' ? undefined : state === 'next' ? { body: 'pending', url: '' } : true;
        surface.page(1);
        expect(surface.atBoundary(1)).toBe(false);
        expect((surface as any).reachableEnd).toBeUndefined();
      },
    );
    it.each(['geometry', 'font'])(
      'does not learn when %s changes during the probe',
      async (change) => {
        f = await measuredFixture();
        const { surface, geometry, writes, fonts } = f;
        surface.viewport.scrollLeft = geometry.end;
        writes.length = 0;
        geometry.onWrite = () => {
          if (writes.length !== 2) return;
          if (change === 'geometry') geometry.renderedWidth += 1;
          else fonts.dispatchEvent(new Event('loadingdone'));
        };
        surface.page(1);
        expect(writes).toHaveLength(2);
        expect(surface.atBoundary(1)).toBe(false);
      },
    );
    it('does not learn an endpoint when the forward probe moves farther', async () => {
      f = await measuredFixture();
      const { surface, geometry, view, writes } = f;
      surface.viewport.scrollLeft = geometry.end - 4;
      geometry.probeMoves = true;
      view.key(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      await f.probe.operations;
      expect(view.file).toBe(f.b);
      expect(writes.at(-1)!.after).toBeGreaterThan(writes.at(-1)!.before);
      expect((surface as any).reachableEnd).toBeUndefined();
    });
    it('rechecks DPR without waiting for a resize observer', async () => {
      f = await measuredFixture();
      const { surface, geometry } = f;
      surface.viewport.scrollLeft = geometry.end;
      surface.page(1);
      expect(surface.atBoundary(1)).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')!;
      try {
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
        expect(surface.atBoundary(1)).toBe(false);
      } finally {
        Object.defineProperty(window, 'devicePixelRatio', descriptor);
      }
    });
    it.each([
      'resize',
      'image',
      'font',
      'font-error',
      'body',
      'url',
      'title',
      'restore',
      'scale',
      'css-zoom',
      'extent',
      'snap',
      'dispose',
    ])('invalidates confirmed reachability after %s', async (change) => {
      f = await measuredFixture();
      const { surface, geometry } = f;
      surface.viewport.scrollLeft = geometry.end;
      surface.page(1);
      expect(surface.atBoundary(1)).toBe(true);
      if (change === 'resize') f.resize();
      if (change === 'image')
        surface.body.appendChild(document.createElement('img')).dispatchEvent(new Event('load'));
      if (change === 'font') f.fonts.dispatchEvent(new Event('loadingdone'));
      if (change === 'font-error') f.fonts.dispatchEvent(new Event('loadingerror'));
      if (change === 'body') surface.setBody('A different article body.', '');
      if (change === 'url')
        surface.setBody(surface.displayedBody!, 'https://example.invalid/changed');
      if (change === 'title') surface.setTitle('A different title');
      if (change === 'restore') surface.restore('missing marker');
      if (change === 'scale') geometry.renderedWidth += 1;
      if (change === 'css-zoom')
        Object.defineProperty(surface.viewport, 'currentCSSZoom', { value: geometry.zoom + 0.1 });
      if (change === 'extent') geometry.extent += geometry.width + 32;
      if (change === 'snap') surface.viewport.style.scrollSnapType = 'x mandatory';
      if (change === 'dispose') surface.dispose();
      expect(surface.atBoundary(1)).toBe(false);
    });
  });

  it.each(['ArrowDown', 'PageDown', 'ArrowUp', 'PageUp'])(
    'uses the existing navigation pipeline once at %s boundary, and ignores repeats',
    async (key) => {
      const f = await fixture();
      const forward = key.endsWith('Down');
      const event = new KeyboardEvent('keydown', { key, cancelable: true });
      f.view.key(event);
      f.view.key(new KeyboardEvent('keydown', { key, repeat: true }));
      f.view.key(new KeyboardEvent('keydown', { key })); // No overlapping boundary jobs.
      expect(event.defaultPrevented).toBe(true);
      await f.probe.operations;
      expect(f.view.file).toBe(forward ? f.c : f.a);
      expect(f.vault.trashed).toEqual([]);
    },
  );
  it.each(['ArrowDown', 'PageDown', 'ArrowUp', 'PageUp'])(
    'does not navigate before the %s boundary; paged keys still page',
    async (key) => {
      const f = await fixture();
      const surface = f.probe.surface;
      surface.atBoundary.mockReturnValue(false);
      const event = new KeyboardEvent('keydown', { key, cancelable: true });
      f.view.key(event);
      expect(event.defaultPrevented).toBe(false);
      f.host.paged = true;
      f.view.key(new KeyboardEvent('keydown', { key, cancelable: true }));
      expect(surface.page).toHaveBeenCalledWith(key.endsWith('Down') ? 1 : -1);
      await f.probe.operations;
      expect(f.view.file).toBe(f.b);
    },
  );
  it.each([
    'repeat',
    'ctrl',
    'alt',
    'meta',
    'shift',
    'input',
    'textarea',
    'select',
    'contenteditable',
    'modal',
    'selection',
    'library',
  ])('does not intercept boundary keys in %s context', async (context) => {
    const f = await fixture();
    const options: KeyboardEventInit = { key: 'ArrowDown', cancelable: true, bubbles: true };
    let target: HTMLElement = f.probe.surface.body;
    if (context === 'repeat') options.repeat = true;
    if (['ctrl', 'alt', 'meta', 'shift'].includes(context))
      (options as any)[`${context}Key`] = true;
    if (['input', 'textarea', 'select'].includes(context))
      target = document.body.appendChild(document.createElement(context));
    if (context === 'contenteditable') {
      target = document.body.createDiv();
      target.setAttribute('contenteditable', '');
    }
    if (context === 'modal') document.body.createDiv({ cls: 'modal-container' });
    if (context === 'selection') {
      const range = document.createRange();
      range.selectNodeContents(target);
      document.getSelection()!.addRange(range);
    }
    if (context === 'library') await f.view.readingList();
    const event = new KeyboardEvent('keydown', options);
    target.addEventListener('keydown', (event) => f.view.key(event), { once: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await f.probe.operations;
    expect(f.view.file).toBe(context === 'library' ? undefined : f.b);
    document.getSelection()?.removeAllRanges();
  });
  it('uses existing queue boundaries: first Up stays, final Down returns to the list', async () => {
    const f = await fixture();
    await f.view.openArticle(f.a.path, true);
    f.probe.surface.atBoundary.mockReturnValue(true);
    f.view.key(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    await f.probe.operations;
    expect(f.view.file).toBe(f.a);
    await f.view.openArticle(f.c.path, true);
    f.probe.surface.atBoundary.mockReturnValue(true);
    f.view.key(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await f.probe.operations;
    expect(f.view.file).toBeUndefined();
    expect(f.view.contentEl.querySelector('.reader-list')).not.toBeNull();
  });
  it('keeps boundary navigation behind the existing flush/source guard', async () => {
    const f = await fixture();
    await enableHighlightHost(f, f.b);
    await f.view.changed({ path: f.b.path, metadataChanged: true });
    f.probe.surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    const raw = createDocument({ type: 'article' }, 'External changed body');
    f.vault.bytes.set(f.b, raw);
    f.view.key(new KeyboardEvent('keydown', { key: 'PageDown' }));
    await expect(f.probe.operations).rejects.toThrow();
    expect(f.view.file).toBe(f.b);
    expect(await f.vault.read(f.b)).toBe(raw);
    expect(mocks.notice).toHaveBeenCalled();
  });
});
