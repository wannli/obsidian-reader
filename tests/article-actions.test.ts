// @vitest-environment node
import {
  mocks,
  hostFixture,
  enableTypedTopics,
  articleAction,
} from './helpers/reader-view-fixture';
import { describe, expect, it, vi } from 'vitest';
import { Platform } from 'obsidian';
import { articleActionKeys } from '../src/reader/article-actions';
import { createDocument } from '../src/core/document';

const labels = (f: ReturnType<typeof hostFixture>) =>
  [...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions > button')].map(
    (button) => button.getAttribute('aria-label'),
  );
const more = (f: ReturnType<typeof hostFixture>) =>
  f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="More article actions"]')!;
const press = (f: ReturnType<typeof hostFixture>, key: string, extra: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...extra });
  f.view.key(event);
  return event;
};

async function fixture(feed = false, paged = false) {
  const f = hostFixture();
  f.host.paged = paged;
  const article = await f.note(feed ? 'Reading/Stream/A.md' : 'Reading/Later/A.md');
  await f.view.openArticle(article.path, true);
  return { ...f, article };
}

describe('contextual five-button article bar', () => {
  it.each([
    [
      false,
      false,
      [
        'Back to list',
        'Highlight mode',
        'Trash article and advance',
        'Archive and advance',
        'More article actions',
      ],
    ],
    [
      true,
      false,
      [
        'Back to list',
        'Save to Later and advance',
        'Archive and advance',
        'Trash article and advance',
        'More article actions',
      ],
    ],
    [
      false,
      true,
      [
        'Back to list',
        'Previous page',
        'Next page',
        'Trash article and advance',
        'More article actions',
      ],
    ],
    [
      true,
      true,
      [
        'Back to list',
        'Previous page',
        'Next page',
        'Trash article and advance',
        'More article actions',
      ],
    ],
  ] as const)('uses the approved layout (feed=%s, paged=%s)', async (feed, paged, expected) => {
    const f = await fixture(feed, paged);
    expect(labels(f)).toEqual(expected);
    expect(articleActionKeys(feed, paged)).toHaveLength(4);
    more(f).click();
    const omitted = [...mocks.menus.at(-1)!.keys()].filter((label) => label !== '---');
    expect(omitted.every((label) => !new Set<string>(expected).has(label))).toBe(true);
    const available = f.probe.articleCommands.map((action: any) => action.label);
    expect([...expected.slice(0, -1), ...omitted].sort()).toEqual(available.sort());
    expect(mocks.menuShown).toHaveBeenCalledOnce();
  });

  it('uses YAML status rather than folder membership or the browsing queue', async () => {
    const f = hostFixture();
    const path = 'Reading/Stream/A.md';
    const article = await f.note(path);
    await f.vault.process(article, () =>
      createDocument({ type: 'article', status: 'later' }, 'Words'),
    );
    f.store.catalog.update(path, { type: 'article', status: 'later' });
    f.probe.queue = 'Later';
    await f.view.openArticle(path, true);
    expect(labels(f)).toContain('Trash article and advance');
    expect(labels(f)).toContain('Highlight mode');
  });

  it('groups secondary reading tools and disposition without duplicating primary actions', async () => {
    const f = await fixture(false, true);
    more(f).click();
    expect([...mocks.menus.at(-1)!.keys()]).toEqual([
      'Highlight mode',
      'Create node',
      'Related notes',
      '---',
      'Save to Later and advance',
      'Archive and advance',
    ]);
    // Check the real separator call, not just the fixture's map entry.
    const menu = f.probe.articleMenu;
    const separator = vi.spyOn(Object.getPrototypeOf(menu), 'addSeparator');
    menu.hide();
    more(f).click();
    expect(separator).toHaveBeenCalledTimes(1);
    expect(more(f).getAttribute('aria-haspopup')).toBe('menu');
    expect(more(f).getAttribute('aria-expanded')).toBe('true');
  });

  it.each([false, true])(
    'keeps guarded deletion directly reachable across queues (paged=%s)',
    async (paged) => {
      const f = hostFixture();
      f.host.paged = paged;
      for (const status of ['inbox', 'later', 'feed', 'archive'] as const) {
        for (const protectedBody of [false, true]) {
          const article = await f.note(`Articles/${status}-${protectedBody}.md`);
          await f.vault.process(article, () =>
            createDocument(
              { type: 'article', status },
              protectedBody ? '==Saved words==' : 'Plain words',
            ),
          );
          f.store.catalog.update(article.path, { type: 'article', status });
          await f.view.openArticle(article.path, true);
          const button = f.view.contentEl.querySelector<HTMLButtonElement>(
            '.reader-actions > button[data-reader-key="t"]',
          )!;
          expect(button).not.toBeNull();
          expect(button.getAttribute('aria-label')).toBe(
            protectedBody ? 'Archive protected article and advance' : 'Trash article and advance',
          );
          button.click();
          await f.probe.operations;
          if (protectedBody) {
            expect(f.vault.trashed).not.toContain(article.path);
            expect((await f.store.read(article.path)).properties.status).toBe('archive');
          } else expect(f.vault.trashed).toContain(article.path);
        }
      }
    },
  );

  it('keeps optional Connect in More without growing the bar and rechecks its availability', async () => {
    const f = await fixture();
    const api = enableTypedTopics(f);
    (api as any).relations = {};
    f.probe.surface.body.innerHTML =
      '<a data-reader-typed-path="One.md"></a><a data-reader-typed-path="Two.md"></a>';
    f.view.refreshArticleControls();
    expect(labels(f)).toHaveLength(5);
    more(f).click();
    expect(mocks.menus.at(-1)!.has('Connect typed notes')).toBe(true);
    delete (api as any).relations;
    f.view.refreshArticleControls();
    more(f).click();
    expect(mocks.menus.at(-1)!.has('Connect typed notes')).toBe(false);
  });

  it('preserves secondary shortcuts, help, held-key guards and active-mode isolation', async () => {
    const f = await fixture(true, true);
    for (const key of ['l', 'a', 'h', 'n', 'r']) {
      const action = f.probe.articleCommands.find((action: any) => action.key === key);
      const run = vi.spyOn(action, 'run').mockImplementation(() => {});
      expect(press(f, key).defaultPrevented).toBe(true);
      expect(run).toHaveBeenCalledOnce();
      expect(press(f, key, { repeat: true }).defaultPrevented).toBe(false);
      expect(run).toHaveBeenCalledOnce();
      run.mockRestore();
    }
    press(f, '?', { shiftKey: true });
    expect(f.view.contentEl.querySelector('.reader-shortcut-help')?.textContent).toContain(
      'Create node',
    );
    press(f, 'Escape');
    articleAction(f.view, 'Highlight mode');
    const archive = vi.spyOn(f.probe, 'changeStatus');
    press(f, 'a');
    expect(archive).not.toHaveBeenCalled();
    expect(
      f.view.contentEl.querySelectorAll('.reader-actions button:not([hidden])').length,
    ).toBeLessThanOrEqual(5);
  });

  it('keeps secondary actions reachable on touch while suppressing desktop shortcuts', async () => {
    Platform.isMobile = true;
    const f = await fixture(true, true);
    const action = f.probe.articleCommands.find((action: any) => action.key === 'l');
    const run = vi.spyOn(action, 'run').mockImplementation(() => {});
    expect(press(f, 'l').defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
    articleAction(f.view, 'Save to Later and advance');
    expect(run).toHaveBeenCalledOnce();
  });

  it('returns menu focus to More on dismissal, but not to detached controls after navigation', async () => {
    const f = await fixture();
    const button = more(f);
    button.focus();
    button.click();
    button.blur();
    mocks.menuClosed.at(-1)!();
    await Promise.resolve();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    const stale = mocks.menus.at(-1)!.get('Save to Later and advance')!;
    const finish = vi.spyOn(f.probe, 'changeStatus');
    f.view.showList();
    stale();
    await Promise.resolve();
    expect(finish).not.toHaveBeenCalled();
    expect(button.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(button);
  });

  it('restores all five controls after each selection mode and keeps the staged selection on refresh', async () => {
    const f = await fixture(true);
    for (const label of ['Highlight mode', 'Create node']) {
      articleAction(f.view, label);
      await Promise.resolve();
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Done');
      const panel = f.view.contentEl.querySelector('.reader-tap-highlight-actions');
      expect(panel).not.toBeNull();
      expect(
        f.view.contentEl.querySelectorAll('.reader-actions button:not([hidden])').length,
      ).toBeLessThanOrEqual(5);
      const highlighter = f.probe.tapHighlighter;
      f.view.refreshArticleControls();
      expect(f.probe.tapHighlighter).toBe(highlighter);
      expect(f.view.contentEl.querySelector('.reader-tap-highlight-actions')).toBe(panel);
      f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Done"]')!.click();
      expect(labels(f)).toHaveLength(5);
      expect(labels(f)).toContain('Trash article and advance');
      expect(document.activeElement).toBe(more(f));
    }
  });

  it.each([200, 260, 390, 1280])(
    'balances five full-size controls at pane width %s',
    async (width) => {
      const f = await fixture();
      const column = f.probe.surface.viewport.parentElement;
      Object.defineProperty(column, 'clientWidth', { value: width });
      Object.defineProperty(f.probe.actions, 'offsetHeight', { value: width < 240 ? 96 : 48 });
      f.probe.tapHighlighter.refreshActions();
      expect(f.probe.actions.style.gridTemplateColumns).toBe(
        width < 240 ? 'repeat(3, 44px)' : 'repeat(5, 44px)',
      );
      expect(column.style.getPropertyValue('--reader-controls-clearance')).toBe(
        `calc(${width < 240 ? 108 : 60}px + var(--reader-controls-bottom))`,
      );
      expect(labels(f)).toHaveLength(5);
    },
  );

  it('keeps page boundaries accurate without replacing focused controls', async () => {
    const f = await fixture(false, true);
    const next = f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!;
    next.focus();
    next.click();
    expect(document.activeElement).toBe(next);
    f.probe.surface.atBoundary.mockImplementation((direction: number) => direction === 1);
    f.probe.updatePagingControls();
    expect(next.disabled).toBe(true);
    expect(f.probe.articleCommands.find((action: any) => action.key === 'x').disabled).toBe(true);
  });
});
