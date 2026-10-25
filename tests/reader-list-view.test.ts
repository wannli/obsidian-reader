// @vitest-environment node
import { mocks, hostFixture, pluginFixture, actionName } from './helpers/reader-view-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Platform, setIcon, setTooltip, TFile } from 'obsidian';
import { patchProperties, readDocument } from '../src/core/document';
import { ReaderView } from '../src/reader/view';
import { showFeeds } from '../src/host/settings';
import { gate } from './helpers/memory-vault';

describe('bounded Reader UI', () => {
  it('keeps library titles as text, with five bottom actions and no search/subtitles/Archive/Feeds buttons', async () => {
    const f = hostFixture();
    await f.note('Reading/Inbox/Visible title.md');
    f.view.showList();
    const buttons = [
      ...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-toolbar button'),
    ];
    expect(buttons.map(actionName)).toEqual([
      'Inbox',
      'Later',
      'Feed articles',
      'Add URL',
      'Filter by topic',
    ]);
    expect(buttons.map((button) => button.querySelector('svg')?.getAttribute('data-icon'))).toEqual(
      ['inbox', 'clock', 'rss', 'plus', 'list-filter'],
    );
    for (const button of buttons) {
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      const tooltip = `${actionName(button)} (${button.dataset.readerKey!.toUpperCase()})`;
      expect(setTooltip).toHaveBeenCalledWith(button, tooltip);
      expect(button.hasAttribute('title')).toBe(false);
      expect(setIcon).toHaveBeenCalledWith(button, expect.any(String));
    }
    expect(f.view.contentEl.querySelector('.reader-list-item')?.textContent).toContain(
      'Visible title',
    );
    expect(
      f.view.contentEl.querySelector('input[type="search"],.reader-list-item small'),
    ).toBeNull();
    expect(f.view.contentEl.lastElementChild?.classList.contains('reader-bottom-controls')).toBe(
      true,
    );
    expect(f.view.contentEl.firstElementChild?.classList.contains('reader-list')).toBe(true);
    const capture = vi.spyOn(f.host, 'capture');
    buttons[3].click();
    expect(capture).toHaveBeenCalledOnce();
    buttons[1].click();
    expect(f.view.getState().queue).toBe('Later');
  });

  it('keeps named pagination icon actions without hiding article row titles', async () => {
    const f = hostFixture();
    for (let i = 0; i < 51; i++) await f.note(`Reading/Inbox/Title ${i}.md`);
    f.view.showList();
    const more = f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Show more"]')!;
    expect(more.textContent).toBe('');
    expect(more.querySelector('svg')?.getAttribute('data-icon')).toBe('chevrons-down');
    const list = f.view.contentEl.querySelector<HTMLElement>('.reader-list')!;
    const first = list.querySelector('.reader-list-item');
    list.scrollTop = 123;
    more.focus();
    more.click();
    expect(list.querySelector('.reader-list-item')).toBe(first);
    expect(list.scrollTop).toBe(123);
    expect(document.activeElement).toBe(list.querySelectorAll('.reader-list-item')[50]);
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(51);
    expect(f.view.contentEl.querySelector('[aria-label="Show more"]')).toBeNull();
  });

  it('reconciles metadata and renames without replacing list rows, focus or click destinations', async () => {
    const f = hostFixture();
    const first = await f.note('Reading/Inbox/A.md');
    await f.note('Reading/Inbox/B.md');
    f.view.showList();
    const list = f.view.contentEl.querySelector<HTMLElement>('.reader-list')!;
    const row = list.querySelector<HTMLButtonElement>('.reader-list-item')!;
    list.scrollTop = 80;
    row.focus();
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    const raw = patchProperties(await f.vault.read(first), { title: 'Z updated' });
    f.vault.bytes.set(first, raw);
    f.store.catalog.update(first.path, readDocument(raw).properties);
    await f.view.changed({ path: first.path, metadataChanged: true });
    frame!(0);
    expect(f.view.contentEl.querySelector('.reader-list')).toBe(list);
    expect([...list.querySelectorAll('.reader-list-item')][1]).toBe(row);
    expect(row.textContent).toBe('Z updated');
    expect(list.scrollTop).toBe(80);
    expect(document.activeElement).toBe(row);
    const previousPath = first.path;
    await f.vault.move(first, 'Reading/Inbox/Renamed.md');
    f.store.catalog.rename(previousPath, first.path, readDocument(raw).properties);
    await f.view.changed({ path: first.path, previousPath, metadataChanged: true });
    frame!(0);
    expect([...list.querySelectorAll('.reader-list-item')][1]).toBe(row);
    const open = vi.spyOn(f.view, 'openArticle').mockResolvedValue();
    row.click();
    await f.probe.operations;
    expect(open).toHaveBeenCalledWith(first.path, true);
  });

  it('opens Archive through the palette, resets old search, and preserves Archive/feed bytes and feeds access', async () => {
    const f = await pluginFixture();
    const saved = await f.note('Reading/Treasury/Saved title.md', 'Authored Archive body');
    const feed = await f.note('Reading/Wires/Feed.md', 'Authored subscription notes', 'feed');
    const before = [await f.vault.read(saved), await f.vault.read(feed)];
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    f.probe.search = 'Unrelated old search';
    f.probe.listLimit = 150;
    const command = mocks.commands.get('open-archive')!;
    expect(command.name).toBe('Open Archive');
    command.callback!();
    await f.probe.operations;
    expect(f.view.getState().queue).toBe('Archive');
    expect(f.probe.search).toBe('');
    expect(f.probe.listLimit).toBe(50);
    expect(f.view.contentEl.querySelector('.reader-list-item')?.textContent).toContain(
      'Saved title',
    );
    expect(mocks.commands.get('manage-feeds')!.name).toBe('Manage feeds');
    mocks.commands.get('manage-feeds')!.callback!();
    expect(showFeeds).toHaveBeenCalledWith(f.app, f.store, f.plugin.ingestion, f.plugin.signal);
    expect([await f.vault.read(saved), await f.vault.read(feed)]).toEqual(before);
    expect(f.vault.trashed).toEqual([]);
  });

  it('opens a new Archive view through the same public workspace route when no Reader is active', async () => {
    const f = await pluginFixture();
    vi.mocked(f.app.workspace.getLeaf).mockReturnValue(f.leaf);
    f.leaf.setViewState.mockImplementation(async (state: any) =>
      f.view.setState(state.state, { history: false }),
    );
    await f.plugin.openList('Archive');
    expect(f.app.workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(f.leaf.setViewState).toHaveBeenCalledWith({
      type: 'obsidian-reader',
      state: { queue: 'Archive' },
      active: true,
    });
    expect(f.view.getState().queue).toBe('Archive');
  });

  it.each([false, true])(
    'scopes mobile navigation to the active Reader, restores on exit/unload (mobile=%s)',
    async (mobile) => {
      const f = await pluginFixture();
      Platform.isMobile = mobile;
      vi.mocked(f.app.workspace.getActiveViewOfType).mockImplementation((type: any) =>
        type === ReaderView ? f.view : (null as any),
      );
      f.workspace('active-leaf-change', f.leaf);
      expect(document.body.classList.contains('reader-mobile-active')).toBe(mobile);
      vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(null);
      // The Reader leaf still exists, but is not active.
      f.workspace('active-leaf-change', { view: {} });
      expect(document.body.classList.contains('reader-mobile-active')).toBe(false);
      vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
      f.workspace('layout-change');
      expect(document.body.classList.contains('reader-mobile-active')).toBe(mobile);
      f.plugin.onunload();
      expect(document.body.classList.contains('reader-mobile-active')).toBe(false);
      f.workspace('active-leaf-change', f.leaf); // A late public event cannot reapply it.
      expect(document.body.classList.contains('reader-mobile-active')).toBe(false);
    },
  );

  it('shares the library action treatment with eight uniform article icons, without hiding authored hr or modal controls', async () => {
    const f = hostFixture();
    const style = document.head.appendChild(document.createElement('style'));
    style.textContent = readFileSync(new URL('../src/reader/styles.css', import.meta.url), 'utf8');
    try {
      f.view.showList();
      const library = f.view.contentEl.querySelector<HTMLButtonElement>(
        '.reader-icon-button:not(.mod-cta)',
      )!;
      const libraryStyle = window.getComputedStyle(library);
      const treatment = [
        libraryStyle.padding,
        libraryStyle.borderRadius,
        libraryStyle.backgroundColor,
        libraryStyle.border,
      ];
      const article = await f.note('Reading/Inbox/Article.md');
      await f.view.openArticle(article.path, true);
      const buttons = [
        ...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button'),
      ];
      expect(
        buttons.map((button) => button.querySelector('svg')?.getAttribute('data-icon')),
      ).toEqual(['list-filter', 'trash-2', 'list', 'highlighter', 'file-plus-2', 'tags']);
      expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
        'Change status and advance · S: choose · L: Later · A: Archive',
        'Trash article and advance',
        'List',
        'Highlight mode',
        'Link or create note',
        'Related notes',
      ]);
      expect(setTooltip).toHaveBeenCalledWith(buttons[5], 'Related notes (T)');
      expect(buttons[5].classList.contains('reader-related-trigger')).toBe(true);
      expect(setTooltip).toHaveBeenCalledWith(
        buttons[0],
        'Change status and advance · S: choose · L: Later · A: Archive',
      );
      expect(buttons.every((button) => !button.hasAttribute('title'))).toBe(true);
      expect(setTooltip).toHaveBeenCalledWith(buttons[3], 'Highlight mode (H)');
      expect(setTooltip).toHaveBeenCalledWith(buttons[4], 'Link or create note (C)');
      expect(setTooltip).toHaveBeenCalledWith(
        f.probe.surface.title,
        'J/K: next/previous article · Space: page · D/U: half-page · gg/G: top/bottom · Q: list · ?: shortcuts',
      );
      for (const button of buttons) {
        const css = window.getComputedStyle(button);
        expect(button.textContent).toBe('');
        expect(css.minWidth).toBe('44px');
        expect(css.minHeight).toBe('44px');
        if (
          !button.matches(
            '.reader-tap-highlight-trigger,.reader-tap-node-trigger,.reader-related-trigger',
          )
        )
          expect([css.padding, css.borderRadius, css.backgroundColor, css.border]).toEqual(
            treatment,
          );
        else {
          expect([css.padding, css.borderRadius]).toEqual(treatment.slice(0, 2));
          // jsdom does not resolve rgba(var(--color-*-rgb)) theme tokens.
          expect(style.textContent).toContain(`.reader-view button.${button.classList[1]}`);
        }
      }
      expect(style.textContent.match(/\.reader-actions \{[^}]+\}/)?.[0]).not.toContain('border');
      const hr = f.probe.surface.body.appendChild(document.createElement('hr'));
      const navbar = document.body.createDiv({ cls: 'mobile-navbar' });
      const formatting = document.body.createDiv({ cls: 'mobile-toolbar' });
      const modal = document.body.createDiv({ cls: 'modal-container' });
      const field = modal.createEl('input', { attr: { 'aria-label': 'Required @ field' } });
      document.body.classList.add('reader-mobile-active');
      expect(window.getComputedStyle(navbar).display).not.toBe('none');
      document.body.classList.add('is-mobile');
      expect(window.getComputedStyle(navbar).display).toBe('none');
      for (const element of [hr, formatting, field, ...buttons])
        expect(window.getComputedStyle(element).display).not.toBe('none');
      document.body.classList.remove('reader-mobile-active');
      expect(window.getComputedStyle(navbar).display).not.toBe('none');
    } finally {
      style.remove();
    }
  });
});

describe('Reader mobile control styling', () => {
  it('declares scoped important shape overrides and an explicit keyboard focus ring', () => {
    const style = document.head.appendChild(document.createElement('style'));
    style.textContent = readFileSync(new URL('../src/reader/styles.css', import.meta.url), 'utf8');
    try {
      const rules = [...style.sheet!.cssRules] as CSSStyleRule[];
      const rule = (selector: string) =>
        rules.find((entry) => entry.selectorText === selector)!.style;
      // JSDOM does not honor !important across later stylesheets. Check priority
      // directly; main's real-browser preview owns the final cascade/layout proof.
      for (const selector of [
        '.reader-view button.reader-icon-button',
        '.reader-view > .reader-list > button.reader-list-item',
      ]) {
        const declarations = rule(selector);
        for (const property of [
          'border-radius',
          'border',
          'background',
          'box-shadow',
          'height',
          'min-height',
        ])
          expect(declarations.getPropertyPriority(property)).toBe('important');
        expect(declarations.getPropertyValue('box-shadow')).toBe('none');
      }
      const focus = rules.find((entry) => entry.selectorText?.includes(':focus-visible'))!.style;
      expect(focus.getPropertyValue('outline')).toBe('2px solid var(--text-normal)');
      expect(focus.getPropertyPriority('outline')).toBe('important');
      expect(
        rule('.reader-view button.reader-icon-button.mod-cta').getPropertyValue('border-color'),
      ).toBe('var(--text-normal)');
      const row = rule('.reader-view > .reader-list > button.reader-list-item');
      expect(row.getPropertyValue('font-size')).toBe('var(--font-ui-medium)');
      expect(parseFloat(rule('.reader-list-title').getPropertyValue('min-width'))).toBe(0);
      expect(rule('.reader-row-indicator').getPropertyValue('flex')).toBe('0 0 auto');
    } finally {
      style.remove();
    }
  });
  it('overrides aggressive mobile pills without changing native/authored controls', async () => {
    const f = hostFixture();
    const title =
      'A fully wrapping article title with a verylongunbrokentitlecomponentthatmustnotbeellipsized';
    const article = await f.note(
      `Reading/Inbox/${title}.md`,
      'Authored body and --- remain unchanged.',
    );
    const raw = await f.vault.read(article);
    const host = document.createElement('style'),
      reader = document.createElement('style');
    host.textContent = `body.is-mobile .view-content button,
      body.is-mobile .view-content input[type='search'] {
        border-radius: 999px; background: purple; color: white;
        box-shadow: 0 8px 20px black; border: 8px solid red;
        width: 100px; height: 100px; min-height: 20px; padding: 30px;
        white-space: nowrap;
      }`;
    reader.textContent = readFileSync(new URL('../src/reader/styles.css', import.meta.url), 'utf8');
    document.head.append(host, reader);
    document.body.classList.add('is-mobile');
    f.view.contentEl.classList.add('view-content');
    try {
      f.view.showList();
      const row = f.view.contentEl.querySelector<HTMLButtonElement>('.reader-list-item')!;
      const rowStyle = window.getComputedStyle(row);
      expect(row.firstChild?.textContent).toBe(title);
      expect(row.querySelector('small')).toBeNull();
      expect(parseFloat(rowStyle.borderRadius)).toBe(0);
      expect(rowStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(rowStyle.boxShadow).toBe('none');
      expect(rowStyle.height).toBe('auto');
      expect(rowStyle.maxHeight).toBe('none');
      expect(rowStyle.minHeight).toBe('44px');
      expect(rowStyle.whiteSpace).toBe('normal');
      expect(rowStyle.overflowWrap).toBe('anywhere');
      expect(rowStyle.overflow).toBe('visible');
      expect(rowStyle.textAlign).toBe('start');
      expect(rowStyle.flexDirection).toBe('row');
      expect(f.view.contentEl.querySelector('input[type="search"]')).toBeNull();
      const checkIcon = (button: HTMLButtonElement, width: string) => {
        const css = window.getComputedStyle(button);
        expect(css.borderRadius).toBe('4px');
        expect(css.boxShadow).toBe('none');
        expect(css.minWidth).toBe('44px');
        expect(css.minHeight).toBe('44px');
        expect(css.height).toBe('44px');
        expect(css.width).toBe(width);
        expect(button.textContent).toBe('');
        expect(button.getAttribute('aria-label')).toBeTruthy();
        expect(window.getComputedStyle(button.querySelector('svg')!).width).toBe('18px');
      };
      for (const button of f.view.contentEl.querySelectorAll<HTMLButtonElement>(
        '.reader-toolbar button',
      ))
        checkIcon(button, '44px');
      await f.view.openArticle(article.path, true);
      const actions =
        f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button');
      expect(actions).toHaveLength(6);
      for (const button of actions) checkIcon(button, '100%');
      expect(actions[0].disabled).toBe(false);
      actions[1].focus();
      expect(document.activeElement).toBe(actions[1]);
      // JSDOM does not resolve theme-variable focus outlines; check their CSSOM
      // declaration separately rather than claiming native focus rendering here.
      const authoredButton = f.probe.surface.body.createEl('button', { text: 'Authored button' });
      const authoredSearch = f.probe.surface.body.createEl('input', { type: 'search' });
      const native = document.body.createDiv({ cls: 'view-content modal-container' });
      const nativeButton = native.createEl('button', { text: 'Native capture action' });
      const nativeSearch = native.createEl('input', { type: 'search' });
      for (const element of [authoredButton, authoredSearch, nativeButton, nativeSearch]) {
        const css = window.getComputedStyle(element);
        expect(css.borderRadius).toBe('999px');
        expect(css.height).toBe('100px');
        expect(css.boxShadow).not.toBe('none');
      }
      expect(await f.vault.read(article)).toBe(patchProperties(raw, { dog_ear: true }));
    } finally {
      host.remove();
      reader.remove();
    }
  });
});

describe('leaf-scoped floating Reader layout', () => {
  it.each([390, 1280].flatMap((width) => [false, true].map((paged) => ({ width, paged }))))(
    'uses full-pane CSS with 5/6/8-action overlays (width=$width, paged=$paged)',
    async ({ width, paged }) => {
      const f = hostFixture();
      const file = await f.note('Reading/Inbox/Title.md');
      const raw = patchProperties(await f.vault.read(file), {
        url: 'https://example.test/article',
        title: 'Full authored title',
      });
      f.vault.bytes.set(file, raw);
      f.store.catalog.update(file.path, readDocument(raw).properties);
      const style = document.head.appendChild(document.createElement('style'));
      style.textContent = readFileSync(
        new URL('../src/reader/styles.css', import.meta.url),
        'utf8',
      );
      f.view.contentEl.style.width = `${width}px`;
      f.host.paged = paged;
      try {
        f.view.showList();
        const list = f.view.contentEl.querySelector('.reader-list')!;
        const library = f.view.contentEl.querySelector('.reader-bottom-controls')!;
        expect(f.view.contentEl.firstElementChild).toBe(list);
        expect(f.view.contentEl.lastElementChild).toBe(library);
        expect(library.querySelectorAll('button')).toHaveLength(5);
        expect(window.getComputedStyle(library).position).toBe('absolute');
        expect(window.getComputedStyle(f.view.contentEl).position).toBe('relative');
        expect(window.getComputedStyle(list).flex).toBe('1 1 auto');
        expect(f.view.contentEl.querySelector('input[type="search"],small')).toBeNull();
        expect(list.textContent).toBe('Full authored title');
        await f.view.openArticle(file.path, true);
        const column = f.view.contentEl.querySelector('.reader-article')!;
        const actions = column.querySelector('.reader-bottom-controls')!;
        const expanded = paged;
        expect(actions.querySelectorAll('button')).toHaveLength(expanded ? 8 : 6);
        expect(column.classList.contains('reader-has-page-actions')).toBe(expanded);
        expect(actions.classList.contains('reader-paged-actions')).toBe(expanded);
        expect(actions.parentElement).toBe(column);
        expect(column.firstElementChild).toBe(f.probe.status);
        expect(window.getComputedStyle(column).position).toBe('relative');
        expect(window.getComputedStyle(column).maxWidth).toBe('none');
        expect(window.getComputedStyle(column).width).toBe('100%');
        expect(window.getComputedStyle(actions).position).toBe('absolute');
        for (const button of actions.querySelectorAll('button')) {
          expect(window.getComputedStyle(button).minHeight).toBe('44px');
          expect(window.getComputedStyle(button).minWidth).toBe('44px');
        }
        // CSSOM establishes the layout contract, not browser/device pixel geometry.
        const rules = [...style.sheet!.cssRules] as CSSStyleRule[];
        const rule = (selector: string) =>
          rules.find((entry) => entry.selectorText === selector)!.style;
        const root = rules.find((entry) =>
          entry.style?.getPropertyValue('--reader-controls-clearance'),
        )!.style;
        expect(root.getPropertyValue('--reader-controls-clearance')).toContain(
          'var(--reader-controls-bottom)',
        );
        expect(root.getPropertyValue('--reader-controls-bottom')).toContain(
          'safe-area-inset-bottom',
        );
        expect(root.getPropertyValue('--reader-scrollbar-clearance')).toBe('16px');
        expect(rule('.reader-list').getPropertyValue('padding-block-end')).toBe(
          'var(--reader-controls-clearance)',
        );
        expect(rule('.reader-list').getPropertyValue('padding-inline-end')).toBe(
          'var(--reader-scrollbar-clearance)',
        );
        expect(
          rule('.reader-viewport:not(.reader-paged) .reader-flow').getPropertyValue(
            'padding-block-end',
          ),
        ).toBe('var(--reader-controls-clearance)');
        expect(rule('.reader-paged').getPropertyValue('margin-block-end')).toBe(
          'var(--reader-controls-clearance)',
        );
        expect(rule('.reader-paged .reader-flow').getPropertyValue('height')).toBe('');
        expect(
          rule('.reader-article.reader-has-page-actions').getPropertyValue(
            '--reader-controls-clearance',
          ),
        ).toContain('108px');
        expect(
          rule('.reader-actions.reader-paged-actions').getPropertyValue('grid-template-columns'),
        ).toBe('repeat(4, 44px)');
        expect(rule('.reader-viewport').getPropertyValue('padding-inline-end')).toBe('');
        expect(rule('.reader-viewport').getPropertyValue('scrollbar-gutter')).toBe('stable');
        expect(
          rule('.reader-view .reader-document.markdown-rendered').getPropertyValue(
            'padding-inline-end',
          ),
        ).toBe('var(--reader-scrollbar-clearance)');
        expect(rule('.reader-article-title').getPropertyValue('padding-inline-end')).toBe(
          'var(--reader-scrollbar-clearance)',
        );
        expect(
          rule('.reader-view .reader-bottom-controls').getPropertyValue('backdrop-filter'),
        ).toBe('');
        expect(await f.vault.read(file)).toBe(patchProperties(raw, { dog_ear: true }));
      } finally {
        style.remove();
      }
    },
  );
});

describe('visible-row evidence indicators', () => {
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  let observers: FakeObserver[], views: ReaderView[];
  let original: PropertyDescriptor | undefined;
  class FakeObserver {
    observed = new Set<Element>();
    disconnect = vi.fn(() => this.observed.clear());
    constructor(
      private callback: (entries: IntersectionObserverEntry[]) => void,
      readonly options: IntersectionObserverInit,
    ) {
      observers.push(this);
    }
    observe(row: Element) {
      this.observed.add(row);
    }
    unobserve(row: Element) {
      this.observed.delete(row);
    }
    intersect(rows: Element[], isIntersecting = true) {
      this.callback(
        rows.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
      );
    }
  }
  beforeEach(() => {
    observers = [];
    views = [];
    original = Object.getOwnPropertyDescriptor(window, 'IntersectionObserver');
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: FakeObserver,
    });
  });
  afterEach(() => {
    for (const view of views) view.stopForUnload();
    if (original) Object.defineProperty(window, 'IntersectionObserver', original);
    else Reflect.deleteProperty(window, 'IntersectionObserver');
  });
  async function fixture(body = '==Highlighted words==', count = 1) {
    const f = hostFixture(),
      files: TFile[] = [];
    views.push(f.view);
    for (let i = 0; i < count; i++) {
      const file = await f.note(`Reading/Stream/${i} Visible.md`, body);
      (file as any).stat = { mtime: 1, size: f.vault.bytes.get(file)!.length };
      files.push(file);
    }
    return { ...f, files };
  }
  it.each([
    ['==words==', true],
    ['==[[Notes/Target|words]]==', true],
    ['> ==first\n> second==', true],
    ['`==code==`', false],
    ['```\n==fenced==\n```', false],
    ['%% ==hidden== %%', false],
    ['[[Notes/Target]]', false],
    ['ordinary words', false],
  ] as const)(
    'uses renderer grammar only after intersection, without promotion/writes: %s',
    async (body, highlighted) => {
      const f = await fixture(body);
      const raw = f.vault.bytes.get(f.files[0]);
      const reads = vi.spyOn(f.vault, 'read'),
        writes = vi.spyOn(f.vault, 'process'),
        moves = vi.spyOn(f.vault, 'move');
      f.view.showList('Feed');
      const row = f.view.contentEl.querySelector('.reader-list-item')!;
      expect(reads).not.toHaveBeenCalled();
      expect(observers[0].options.root).toBe(f.view.contentEl.querySelector('.reader-list'));
      observers[0].intersect([row]);
      await settle();
      expect(reads).toHaveBeenCalledExactlyOnceWith(f.files[0]);
      const indicator = row.querySelector('.reader-highlight-indicator');
      expect(!!indicator).toBe(highlighted);
      if (indicator) {
        expect(indicator.getAttribute('role')).toBe('img');
        expect(indicator.getAttribute('aria-label')).toBe('Has highlights');
        expect(indicator.querySelector('svg')?.getAttribute('data-icon')).toBe('highlighter');
      }
      expect(row.textContent).toBe('0 Visible');
      expect(writes).not.toHaveBeenCalled();
      expect(moves).not.toHaveBeenCalled();
      expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
      expect(f.files[0].path).toBe('Reading/Stream/0 Visible.md');
      expect(f.vault.bytes.get(f.files[0])).toBe(raw);
      expect(f.vault.trashed).toEqual([]);
    },
  );
  it.each([
    { position: undefined, opened: false },
    { position: '', opened: false },
    { position: '   ', opened: false },
    { position: false, opened: false },
    { position: 0, opened: false },
    { position: { quote: 'words' }, opened: false },
    { position: ['words'], opened: false },
    { position: 'x'.repeat(257), opened: false },
    { position: 'words', opened: true },
    { position: 'Text no longer in this article', opened: true },
  ])(
    'derives opened-before from existing usable position evidence only: $position',
    async ({ position, opened }) => {
      const f = await fixture('==words=='),
        file = f.files[0];
      const raw = patchProperties(f.vault.bytes.get(file)!, {
        bookmark: position,
        unknown_evidence: 'Keep',
        explicit_false: false,
        explicit_zero: 0,
      });
      f.vault.bytes.set(file, raw);
      file.stat.size = raw.length;
      const reads = vi.spyOn(f.vault, 'read'),
        writes = vi.spyOn(f.vault, 'process'),
        positions = vi.spyOn(f.store, 'position'),
        moves = vi.spyOn(f.vault, 'move');
      f.view.showList('Feed');
      const row = f.view.contentEl.querySelector('.reader-list-item')!;
      expect(reads).not.toHaveBeenCalled();
      observers[0].intersect([row]);
      await settle();
      const indicator = row.querySelector('.reader-opened-indicator');
      expect(!!indicator).toBe(opened);
      if (indicator) {
        expect(indicator.getAttribute('aria-label')).toBe('Opened before');
        expect(indicator.querySelector('svg')?.getAttribute('data-icon')).toBe('eye');
      }
      expect(row.querySelectorAll('.reader-row-indicator')).toHaveLength(1 + Number(opened));
      expect(row.querySelector('.reader-highlight-indicator')).not.toBeNull();
      expect(reads).toHaveBeenCalledExactlyOnceWith(file);
      expect(writes).not.toHaveBeenCalled();
      expect(positions).not.toHaveBeenCalled();
      expect(moves).not.toHaveBeenCalled();
      expect(f.vault.bytes.get(file)).toBe(raw);
      expect(file.path).toBe('Reading/Stream/0 Visible.md');
      expect(row.textContent).toBe('0 Visible');
    },
  );
  it('refreshes a completed visible row after bookmark/body-only change events without rebuilding the list', async () => {
    const f = await fixture('ordinary words');
    const file = f.files[0];
    const original = f.vault.bytes.get(file)!;
    const reads = vi.spyOn(f.vault, 'read');
    const writes = vi.spyOn(f.vault, 'process');
    f.view.showList('Feed');
    const row = f.view.contentEl.querySelector('.reader-list-item')!;
    observers[0].intersect([row]);
    await settle();
    const changed = patchProperties(original.replace('ordinary words', '==ordinary words=='), {
      bookmark: 'ordinary words',
    });
    f.vault.bytes.set(file, changed);
    // Keep coarse stats identical: path-specific invalidation, not stat changes, is required.
    await f.view.changed({ path: file.path, metadataChanged: false });
    await settle();
    expect(f.view.contentEl.querySelector('.reader-list-item')).toBe(row);
    expect(row.querySelectorAll('.reader-row-indicator')).toHaveLength(2);
    f.vault.bytes.set(file, original);
    await f.view.changed({ path: file.path, metadataChanged: false });
    await settle();
    expect(row.querySelectorAll('.reader-row-indicator')).toHaveLength(0);
    expect(reads).toHaveBeenCalledTimes(3);
    expect(writes).not.toHaveBeenCalled();
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
  });
  it('caps reads at two even across rerenders, drops old pending rows and never reads offscreen rows', async () => {
    const f = await fixture('==words==', 5),
      release = gate();
    const read = f.vault.read.bind(f.vault);
    let live = 0,
      peak = 0;
    const reads = vi.spyOn(f.vault, 'read').mockImplementation(async (file) => {
      live++;
      peak = Math.max(peak, live);
      try {
        await release.promise;
        return await read(file);
      } finally {
        live--;
      }
    });
    f.view.showList('Feed');
    const oldRows = [...f.view.contentEl.querySelectorAll('.reader-list-item')];
    observers[0].intersect(oldRows.slice(0, 3));
    expect(reads).toHaveBeenCalledTimes(2);
    f.view.showList('Feed');
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    const rows = [...f.view.contentEl.querySelectorAll('.reader-list-item')];
    observers[1].intersect(rows.slice(0, 3));
    expect(reads).toHaveBeenCalledTimes(2);
    release.resolve();
    await settle();
    expect(peak).toBe(2);
    expect(reads).toHaveBeenCalledTimes(5); // Two old dispatched reads, three current visible rows.
    expect(reads.mock.calls.every(([file]) => f.files.slice(0, 3).includes(file as TFile))).toBe(
      true,
    );
    expect(oldRows.every((row) => !row.querySelector('.reader-highlight-indicator'))).toBe(true);
    expect(
      rows.slice(0, 3).every((row) => !!row.querySelector('.reader-highlight-indicator')),
    ).toBe(true);
    expect(rows.slice(3).every((row) => !row.querySelector('.reader-highlight-indicator'))).toBe(
      true,
    );
  });
  it.each(['offscreen', 'rename', 'replacement', 'revision', 'queue', 'unload', 'host-stop'])(
    'discards a read completed after %s',
    async (change) => {
      const f = await fixture(),
        release = gate(),
        raw = patchProperties(f.vault.bytes.get(f.files[0])!, { bookmark: 'words' });
      f.vault.bytes.set(f.files[0], raw);
      f.files[0].stat.size = raw.length;
      vi.spyOn(f.vault, 'read').mockImplementationOnce(async () => {
        await release.promise;
        return raw;
      });
      f.view.showList('Feed');
      const row = f.view.contentEl.querySelector('.reader-list-item')!;
      observers[0].intersect([row]);
      if (change === 'offscreen') observers[0].intersect([row], false);
      if (change === 'rename') f.files[0].path = 'Reading/Stream/Renamed.md';
      if (change === 'replacement') f.vault.files.set(f.files[0].path, {} as any);
      if (change === 'revision') f.files[0].stat.mtime++;
      if (change === 'queue') f.view.showList('Inbox');
      if (change === 'unload') f.view.stopForUnload();
      if (change === 'host-stop') f.signal.abort();
      release.resolve();
      await settle();
      expect(row.querySelector('.reader-row-indicator')).toBeNull();
      expect(f.view.contentEl.querySelector('.reader-row-indicator')).toBeNull();
      expect(mocks.notice).not.toHaveBeenCalled();
    },
  );
  it('degrades without observers or on unreadable source without making a negative/read-state claim', async () => {
    const f = await fixture();
    const reads = vi.spyOn(f.vault, 'read').mockRejectedValue(new Error('Unavailable'));
    f.view.showList('Feed');
    const row = f.view.contentEl.querySelector('.reader-list-item')!;
    observers[0].intersect([row]);
    await settle();
    expect(row.textContent).toBe('0 Visible');
    expect(row.querySelector('.reader-highlight-indicator')).toBeNull();
    expect(mocks.notice).not.toHaveBeenCalled();
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: undefined });
    reads.mockClear();
    f.view.showList('Feed');
    expect(reads).not.toHaveBeenCalled();
    expect(f.view.contentEl.querySelector('.reader-list-item')?.textContent).toBe('0 Visible');
  });
});
