// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FileView,
  MarkdownView,
  Platform,
  setIcon,
  setTooltip,
  TFile,
  type App,
  type Command,
  type WorkspaceLeaf,
} from 'obsidian';
import { ArticleStore, type VaultPort } from '../src/core/store';
import { defaultFolders, type ReaderFolders } from '../src/core/folders';
import { createDocument, patchProperties, readDocument } from '../src/core/document';
import { passages } from '../src/core/annotations';
import { READER_VIEW, ReaderView, nativeLinkPath, openExistingNote } from '../src/reader/view';
import * as surfaceModule from '../src/reader/surface';
import ReaderPlugin from '../src/main';
import { showFeeds } from '../src/host/settings';
import type { NodesApi, NodeResult } from '../src/host/nodes';
import { gate, MemoryVault } from './helpers/memory-vault';

// Obsidian has declarations only: server-side mock resolution plus a local DOM,
// matching the ingestion unit suite, without a browser/runtime adapter.
const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));
const mocks = vi.hoisted(() => ({
  choose: vi.fn(),
  topics: vi.fn(),
  notice: vi.fn(),
  input: vi.fn(),
  confirmWebLink: vi.fn(),
  menus: [] as Map<string, () => void>[],
  dom: new Map<string, () => void>(),
  commands: new Map<string, Command>(),
  protocols: new Map<string, (params: Record<string, string>) => unknown>(),
  renderError: undefined as Error | undefined,
}));
vi.mock('obsidian', () => {
  class FileView {
    file?: unknown;
  }
  class MarkdownView extends FileView {
    getMode() {
      return 'preview';
    }
  }
  class TFile {
    path = '';
    get extension() {
      return 'md';
    }
    get basename() {
      return this.path.split('/').pop()!.replace(/\.md$/, '');
    }
  }
  class ItemView {
    app: unknown;
    containerEl = document.createElement('div');
    contentEl = document.createElement('div');
    constructor(public leaf: any) {
      this.app = leaf.app;
      this.containerEl.append(this.contentEl);
      document.body.append(this.containerEl);
    }
    async setState() {}
  }
  class Menu {
    items = new Map<string, () => void>();
    constructor() {
      mocks.menus.push(this.items);
    }
    addItem(build: (item: any) => void) {
      let title = '';
      const item = {
        setTitle(value: string) {
          title = value;
          return item;
        },
        onClick(run: () => void) {
          thisMenu.items.set(title, run);
          return item;
        },
      };
      const thisMenu = this;
      build(item);
      return this;
    }
    addSeparator() {
      this.items.set('---', () => {});
      return this;
    }
    showAtMouseEvent() {}
  }
  class Plugin {
    app: any;
    async loadData() {
      return {};
    }
    registerEvent() {}
    registerView() {}
    addRibbonIcon() {}
    addCommand(command: Command) {
      mocks.commands.set(command.id, command);
    }
    addSettingTab() {}
    registerObsidianProtocolHandler(
      name: string,
      handler: (params: Record<string, string>) => unknown,
    ) {
      mocks.protocols.set(name, handler);
    }
    registerInterval(id: number) {
      window.clearInterval(id);
    }
    registerDomEvent(_target: unknown, name: string, callback: () => void) {
      mocks.dom.set(name, callback);
    }
  }
  return {
    FileView,
    MarkdownView,
    TFile,
    ItemView,
    Menu,
    Plugin,
    Platform: { isMobile: false },
    setIcon: vi.fn((element: HTMLElement, icon: string) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('svg-icon');
      svg.setAttribute('data-icon', icon);
      element.replaceChildren(svg);
    }),
    setTooltip: vi.fn((element: HTMLElement, label: string) => {
      element.setAttribute('aria-label', label);
    }),
    Notice: class {
      constructor(message: string) {
        mocks.notice(message);
      }
    },
    parseLinktext: (value: string) => {
      const at = value.indexOf('#');
      return at < 0
        ? { path: value, subpath: '' }
        : { path: value.slice(0, at), subpath: value.slice(at) };
    },
  };
});
vi.mock('../src/host/dialogs', () => ({
  choose: mocks.choose,
  chooseTopics: mocks.topics,
  input: mocks.input,
  confirmWebLink: mocks.confirmWebLink,
}));
vi.mock('../src/host/settings', () => ({ ReaderSettings: class {}, showFeeds: vi.fn() }));
vi.mock('../src/host/vault', () => ({
  ObsidianVault: class {
    constructor(app: any) {
      return app.__vault;
    }
  },
  watchLibrary: () => () => {},
}));
vi.mock('../src/host/ingestion', () => ({
  Ingestion: class {
    acquire = vi.fn(async () => {});
    refreshAll = vi.fn(async () => {});
    stop = vi.fn();
  },
}));
vi.mock('../src/reader/surface', () => ({
  ReadingSurface: class {
    body = document.createElement('article');
    title = document.createElement('h1');
    setTitle = (title: string) => {
      this.title.textContent = title;
    };
    canPage = vi.fn(() => false);
    atBoundary = vi.fn(() => false);
    selectionValue?: unknown;
    marker?: string;
    displayedBody?: string;
    deferred?: string;
    hold = false;
    setBody = vi.fn((body: string) => {
      if (this.hold || this.selectionValue) {
        this.deferred = body;
        return;
      }
      if (mocks.renderError) {
        this.displayedBody = undefined;
        this.renderError?.(mocks.renderError);
        return;
      }
      this.displayedBody = body;
      this.body.textContent = body;
      this.deferred = undefined;
    });
    selection = () => this.selectionValue;
    refresh = vi.fn(() => {
      if (this.deferred !== undefined && !this.hold && !this.selectionValue)
        this.setBody(this.deferred);
    });
    restore = vi.fn();
    page = vi.fn();
    reveal = vi.fn();
    highlightFeedback = vi.fn(() => vi.fn());
    dispose = vi.fn();
    constructor(
      parent: HTMLElement,
      _paged: boolean,
      private position: (marker: string) => void,
      private renderError?: (error: unknown) => void,
    ) {
      parent.append(this.title, this.body);
    }
    flush() {
      if (this.marker) this.position(this.marker);
    }
  },
}));

beforeAll(() => {
  Object.assign(HTMLElement.prototype, {
    empty(this: HTMLElement) {
      this.replaceChildren();
    },
    addClass(this: HTMLElement, name: string) {
      this.classList.add(name);
    },
    createEl(this: HTMLElement, tag: string, options: any = {}) {
      const element = document.createElement(tag);
      if (options.text) element.textContent = options.text;
      if (options.cls) element.className = options.cls;
      for (const [key, value] of Object.entries(options.attr ?? {}))
        element.setAttribute(key, String(value));
      if (options.type) element.setAttribute('type', options.type);
      if (options.placeholder) element.setAttribute('placeholder', options.placeholder);
      this.append(element);
      return element;
    },
    createDiv(this: HTMLElement, options: any = {}) {
      return this.createEl('div', options);
    },
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.menus.length = 0;
  mocks.dom.clear();
  mocks.commands.clear();
  mocks.protocols.clear();
  mocks.renderError = undefined;
  Platform.isMobile = false;
  mocks.choose.mockReset().mockResolvedValue(null);
  mocks.topics.mockResolvedValue(null);
});
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  document.body.classList.remove('is-mobile', 'reader-mobile-active');
  vi.restoreAllMocks();
});

function hostFixture(folders: ReaderFolders = defaultFolders) {
  const vault = new MemoryVault();
  const workspaceEvents = new Map<string, ((...args: any[]) => void)[]>(),
    metadataEvents = new Map<string, ((...args: any[]) => void)[]>();
  const layouts: (() => void)[] = [],
    leaves: any[] = [],
    cache = new Map<any, any>();
  const listen =
    (events: typeof workspaceEvents) => (name: string, callback: (...args: any[]) => void) => {
      events.set(name, [...(events.get(name) ?? []), callback]);
      return {};
    };
  const emit = (events: typeof workspaceEvents, name: string, ...args: any[]) => {
    for (const callback of events.get(name) ?? []) callback(...args);
  };
  const opened = { openFile: vi.fn(async () => {}) };
  const app: any = {
    __vault: vault,
    vault: {
      getName: vi.fn(() => 'Device-local Reader vault'),
      getMarkdownFiles: () => [...vault.files.values()],
      getAbstractFileByPath: (path: string) => vault.file(path),
    },
    metadataCache: {
      on: listen(metadataEvents),
      resolvedLinks: {},
      getFileCache: (file: any) => cache.get(file),
      getFirstLinkpathDest: vi.fn((path: string) => vault.file(path) ?? vault.file(`${path}.md`)),
    },
    workspace: {
      on: listen(workspaceEvents),
      onLayoutReady: (callback: () => void) => layouts.push(callback),
      getLeavesOfType: (type: string) =>
        leaves.filter((leaf) => leaf.view?.getViewType?.() === type),
      iterateAllLeaves: (callback: (leaf: any) => void) => leaves.forEach(callback),
      getMostRecentLeaf: () => leaves[0],
      getLeaf: vi.fn(() => opened),
      getActiveViewOfType: vi.fn(() => undefined),
      requestSaveLayout: vi.fn(),
      revealLeaf: vi.fn(async () => {}),
    },
  };
  const store = new ArticleStore(vault as unknown as VaultPort<TFile>, folders);
  const signal = new AbortController();
  const host: any = {
    app,
    store,
    signal: signal.signal,
    paged: false,
    ingestion: { acquire: vi.fn(async () => {}) },
    capture() {},
    feeds() {},
    async edit() {},
  };
  const leaf: any = { app, setViewState: vi.fn(async () => {}) };
  leaves.push(leaf);
  const view = new ReaderView(leaf as WorkspaceLeaf, host);
  leaf.view = view;
  async function note(path: string, body = 'before words after', type = 'article') {
    const file = await vault.create(path, createDocument({ type }, body));
    Object.setPrototypeOf(file, TFile.prototype);
    cache.set(file, { frontmatter: { type }, sections: [{ type: 'paragraph' }], links: [] });
    store.catalog.update(path, { type });
    return file as TFile;
  }
  return {
    vault,
    app: app as App,
    store,
    host,
    signal,
    leaf,
    leaves,
    view,
    probe: view as any,
    note,
    cache,
    layouts,
    opened,
    workspace: (name: string, ...args: any[]) => emit(workspaceEvents, name, ...args),
    metadata: (name: string, ...args: any[]) => emit(metadataEvents, name, ...args),
  };
}
async function pluginFixture() {
  const fixture = hostFixture(),
    plugin = new ReaderPlugin(fixture.app, {} as any);
  (plugin as any).app = fixture.app;
  await plugin.onload();
  plugin.store = fixture.store;
  return { ...fixture, plugin, pluginProbe: plugin as any };
}
function actionName(button: Element): string {
  const label = button.getAttribute('aria-label') ?? button.textContent ?? '';
  if (label === 'Trash article and advance') return 'Delete';
  return label.replace(/ (?:page or article|article(?: and advance)?)$/, '');
}
function menu(view: ReaderView, title: string) {
  const probe = view as any;
  probe.passageMenu(passages(probe.snapshot.body)[0], new MouseEvent('click'));
  const action = mocks.menus.at(-1)!.get(title);
  expect(action).toBeTypeOf('function');
  action!();
  return probe.operations as Promise<void>;
}

describe('Reader operation and close lifecycle', () => {
  it('uses the plugin-namespaced view registry without selecting unrelated generic reader leaves', async () => {
    const f = await pluginFixture();
    f.leaves.push({ view: { getViewType: () => 'reader' } });
    const leaves = vi.spyOn(f.app.workspace, 'getLeavesOfType');
    expect(f.view.getViewType()).toBe('obsidian-reader');
    expect(f.pluginProbe.views()).toEqual([f.view]);
    expect(leaves).toHaveBeenCalledWith('obsidian-reader');
  });

  it('serializes a slow move before navigation without mixing snapshots and bodies', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md', 'article A'),
      b = await f.note('Reading/Inbox/B.md', 'article B');
    await f.view.openArticle(a.path);
    const started = gate(),
      finish = gate();
    f.vault.beforeMove = async () => {
      started.resolve();
      await finish.promise;
    };
    mocks.choose.mockResolvedValue('Later');
    const moving = f.probe.move();
    await started.promise;
    const navigating = f.view.openArticle(b.path);
    expect(f.view.file).toBe(a);
    finish.resolve();
    await Promise.all([moving, navigating]);
    expect(f.view.file).toBe(b);
    expect(f.probe.surface.body.textContent).toBe('article B');
  });

  it('drains a pending selection and position on normal close, without waiting for debounce', async () => {
    const f = hostFixture(),
      file = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(file.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    surface.marker = 'words';
    f.probe.selectionChanged();
    await f.view.onClose();
    const saved = readDocument(await f.vault.read(file));
    expect(saved.body).toBe('before ==words== after');
    expect(saved.properties.reading_position).toBe('words');
    expect(surface.dispose).toHaveBeenCalledOnce();
    expect(f.probe.surface).toBeUndefined();
  });

  it('Delete & next survives the synchronous native delete notification', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(a.path, true);
    const trash = f.vault.trash.bind(f.vault);
    vi.spyOn(f.vault, 'trash').mockImplementation(async (file) => {
      await trash(file);
      await f.view.changed({ path: file.path, deleted: true });
    });
    await f.probe.finish('delete');
    expect(f.view.file).toBe(b);
    expect(f.vault.trashed).toEqual([a.path]);
  });

  it('cancels queued navigation on close and never mounts a late move result', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(a.path);
    const started = gate(),
      finish = gate();
    f.vault.beforeMove = async () => {
      started.resolve();
      await finish.promise;
    };
    mocks.choose.mockResolvedValue('Later');
    const moving = f.probe.move();
    await started.promise;
    const surface = f.probe.surface,
      closing = f.view.onClose(),
      navigating = f.view.openArticle(b.path);
    finish.resolve();
    await Promise.all([moving, closing, navigating]);
    expect(f.view.file).not.toBe(b);
    expect(f.probe.surface).toBeUndefined();
    expect(surface.dispose).toHaveBeenCalledOnce();
  });

  it('ignores a metadata read that completes after navigation', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md', 'new article');
    await f.view.openArticle(a.path);
    const old = await f.store.read(a.path),
      started = gate(),
      finish = gate(),
      read = f.store.read.bind(f.store);
    vi.spyOn(f.store, 'read').mockImplementation(async (path) => {
      if (path === a.path) {
        started.resolve();
        await finish.promise;
        return old;
      }
      return read(path);
    });
    const updating = f.view.changed({ path: a.path });
    await started.promise;
    await f.view.openArticle(b.path);
    finish.resolve();
    await updating;
    expect(f.view.file).toBe(b);
    expect(f.probe.surface.body.textContent).toBe('new article');
  });

  it('detaches immediately on unload even when a provider ignores dialog cancellation', async () => {
    const f = await pluginFixture(),
      article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path);
    const started = gate(),
      release = gate(),
      surface = f.probe.surface;
    mocks.choose.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return 'Later';
    });
    const moving = f.probe.move();
    await started.promise;
    f.plugin.onunload();
    expect(surface.dispose).toHaveBeenCalledOnce();
    expect(f.probe.surface).toBeUndefined();
    await f.view.onClose(); // Must not wait for the still-pending provider.
    release.resolve();
    await moving;
    expect(article.path).toBe('Reading/Inbox/A.md');
    expect(f.probe.surface).toBeUndefined();
  });

  it('keeps both highlights when identical words are selected in different contexts', async () => {
    const f = hostFixture(),
      file = await f.note('Reading/Inbox/A.md', 'First words end. Second words stop.');
    await f.view.openArticle(file.path);
    f.probe.surface.selectionValue = {
      quote: 'words',
      before: 'First ',
      after: ' end. Second words stop.',
    };
    await f.probe.saveSelection();
    f.probe.surface.selectionValue = {
      quote: 'words',
      before: 'First words end. Second ',
      after: ' stop.',
    };
    await f.probe.saveSelection();
    expect((await f.store.read(file.path)).body).toBe(
      'First ==words== end. Second ==words== stop.',
    );
  });
});

describe('automatic selection event ownership', () => {
  let f: Awaited<ReturnType<typeof selectionFixture>>;
  async function selectionFixture() {
    const actual = await vi.importActual<typeof surfaceModule>('../src/reader/surface');
    vi.spyOn(surfaceModule, 'ReadingSurface').mockImplementation(function (...args) {
      return new actual.ReadingSurface(...args);
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getClientRects = () => [] as unknown as DOMRectList;
      range.getBoundingClientRect = () => new DOMRect();
      return range;
    });
    const f = hostFixture(),
      body = 'Alpha phrase.\n\nBeta phrase.',
      article = await f.note('Reading/Inbox/Selection.md', body);
    await f.view.onOpen();
    await f.view.openArticle(article.path);
    const surface = f.probe.surface as surfaceModule.ReadingSurface;
    function select(paragraph: number, end = paragraph === 0 ? 5 : 4, notify = true) {
      const node = surface.body.querySelectorAll('p')[paragraph].firstChild!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, end);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      if (notify) document.dispatchEvent(new Event('selectionchange'));
    }
    return { ...f, article, body, surface, select };
  }
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    f = await selectionFixture();
  });
  afterEach(() => {
    f?.view.stopForUnload();
    document.getSelection()?.removeAllRanges();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('mounts one aligned article column with exactly five persistent actions outside the scroller', () => {
    const column = f.view.contentEl.querySelector('.reader-article')!;
    const actions = column.querySelector('.reader-actions')!;
    expect([...actions.querySelectorAll('button')].map(actionName)).toEqual([
      'Previous',
      'Next',
      'Keep',
      'Delete',
      'List',
    ]);
    expect(actions.parentElement).toBe(f.surface.viewport.parentElement);
    expect(f.surface.viewport.contains(actions)).toBe(false);
    expect([...f.surface.flow.children]).toEqual([f.surface.title, f.surface.body]);
    expect(f.view.contentEl.querySelector('.reader-toolbar,.reader-finish')).toBeNull();
    expect(f.view.contentEl.textContent).not.toContain('End of article');
  });

  function gesture(
    type: string,
    target: EventTarget = f.surface.body,
    pointerType = 'touch',
    pointerId = 1,
  ): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, {
      button: 0,
      pointerId,
      pointerType,
      changedTouches: [{ identifier: pointerId }],
    });
    target.dispatchEvent(event);
    return event;
  }

  it.each(['article', 'list', 'controls', 'margin'] as const)(
    'isolates the whole mobile gesture throughout Reader %s without cancelling defaults or same-element handlers',
    async (area) => {
      if (area === 'list') await f.view.readingList();
      const target =
        area === 'list'
          ? f.view.contentEl.querySelector('.reader-list-item')!
          : area === 'controls'
            ? f.view.contentEl.querySelector('.reader-actions button')!
            : area === 'margin'
              ? f.view.contentEl
              : f.surface.body;
      const workspace = vi.fn(),
        reader = vi.fn(),
        capture = vi.fn();
      const types = [
        'pointerdown',
        'touchstart',
        'pointermove',
        'touchmove',
        'pointerup',
        'pointercancel',
        'touchend',
        'touchcancel',
      ];
      for (const type of types) {
        f.view.containerEl.addEventListener(type, workspace);
        f.view.containerEl.addEventListener(type, capture, { capture: true });
        f.view.contentEl.addEventListener(type, reader);
        expect(gesture(type, target).defaultPrevented).toBe(false);
      }
      expect(workspace).not.toHaveBeenCalled();
      expect(reader).toHaveBeenCalledTimes(types.length);
      expect(capture).toHaveBeenCalledTimes(types.length); // Not a capture-phase barrier.
      expect(f.probe.selecting).toBe(false);
    },
  );

  it.each(
    ['touch', 'pen'].flatMap((kind) =>
      ['pointerup', 'pointercancel'].map((release) => ({ kind, release })),
    ),
  )(
    'preserves selection and saves exactly once 900ms after isolated $kind $release',
    async ({ kind, release }) => {
      const annotate = vi.spyOn(f.store, 'annotate'),
        workspace = vi.fn();
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend'])
        f.view.containerEl.addEventListener(type, workspace);
      gesture('pointerdown', f.surface.body, kind);
      if (kind === 'touch') gesture('touchstart');
      expect(f.surface.pointerActive).toBe(true);
      f.select(0);
      vi.advanceTimersByTime(1200);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      gesture(release, f.surface.body, kind);
      expect(f.surface.pointerActive).toBe(false);
      if (kind === 'touch') {
        vi.advanceTimersByTime(1200); // A known touch remains even after pointer release/cancel.
        await f.probe.operations;
        expect(annotate).not.toHaveBeenCalled();
        gesture('touchend');
      }
      vi.advanceTimersByTime(899);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await f.probe.operations;
      expect(annotate).toHaveBeenCalledOnce();
      expect((await f.store.read(f.article.path)).body).toBe('==Alpha== phrase.\n\nBeta phrase.');
      expect(document.getSelection()!.toString()).toBe('Alpha');
      expect(workspace).not.toHaveBeenCalled();
    },
  );

  it('restarts the full 900ms quiet period for every adjustment, including repeated text', async () => {
    const annotate = vi.spyOn(f.store, 'annotate');
    f.select(0);
    vi.advanceTimersByTime(899);
    f.select(1);
    vi.advanceTimersByTime(899);
    f.select(1);
    vi.advanceTimersByTime(899);
    await f.probe.operations;
    expect(annotate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await f.probe.operations;
    expect(annotate).toHaveBeenCalledOnce();
    expect((await f.store.read(f.article.path)).body).toBe('Alpha phrase.\n\n==Beta== phrase.');
    expect(document.getSelection()!.toString()).toBe('Beta');
  });

  it.each(['pointerup', 'pointercancel', 'touchend', 'touchcancel'])(
    'retains the outside-Reader %s fallback and its full quiet period',
    async (release) => {
      const annotate = vi.spyOn(f.store, 'annotate');
      gesture(release.startsWith('touch') ? 'touchstart' : 'pointerdown');
      f.select(0);
      vi.advanceTimersByTime(1200);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      expect(gesture(release, document.body).defaultPrevented).toBe(false);
      expect(f.surface.pointerActive).toBe(false);
      expect(f.probe.selecting).toBe(false);
      vi.advanceTimersByTime(899);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await f.probe.operations;
      expect(annotate).toHaveBeenCalledOnce();
      expect(document.getSelection()!.toString()).toBe('Alpha');
    },
  );

  it('does not isolate mouse, click or keyboard events', () => {
    const workspace = vi.fn();
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'click',
      'keydown',
    ]) {
      f.view.containerEl.addEventListener(type, workspace);
      expect(gesture(type, f.surface.body, 'mouse').defaultPrevented).toBe(false);
    }
    expect(workspace).toHaveBeenCalledTimes(6);
  });

  it('leaves native headers, other leaves and dialogs outside the mobile boundary', () => {
    const header = document.createElement('button'),
      other = document.createElement('div'),
      dialog = document.createElement('dialog'),
      outside = vi.fn(),
      click = vi.fn(),
      events = new AbortController();
    f.view.containerEl.prepend(header);
    document.body.append(other, dialog);
    document.addEventListener('touchmove', outside, { signal: events.signal });
    header.addEventListener('click', click);
    try {
      for (const target of [header, other, dialog])
        expect(gesture('touchmove', target).defaultPrevented).toBe(false);
      header.click();
      expect(outside).toHaveBeenCalledTimes(3);
      expect(click).toHaveBeenCalledOnce();
    } finally {
      events.abort();
    }
  });

  it.each(['close', 'unload', 'host retirement'])(
    'removes mobile interception after %s',
    async (end) => {
      const workspace = vi.fn(),
        annotate = vi.spyOn(f.store, 'annotate');
      f.view.containerEl.addEventListener('touchstart', workspace);
      if (end === 'close') await f.view.onClose();
      else if (end === 'unload') f.view.stopForUnload();
      else f.signal.abort();
      expect(gesture('touchstart', f.view.contentEl).defaultPrevented).toBe(false);
      expect(workspace).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1200);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
    },
  );

  it('keeps a touch-only adjustment held until every known touch releases', async () => {
    const annotate = vi.spyOn(f.store, 'annotate');
    gesture('touchstart', f.surface.body, 'touch', 1);
    gesture('touchstart', f.surface.body, 'touch', 2);
    f.select(0);
    gesture('touchend', f.surface.body, 'touch', 1);
    vi.advanceTimersByTime(1200);
    await f.probe.operations;
    expect(annotate).not.toHaveBeenCalled();
    gesture('touchcancel', f.surface.body, 'touch', 2);
    vi.advanceTimersByTime(899);
    await f.probe.operations;
    expect(annotate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await f.probe.operations;
    expect(annotate).toHaveBeenCalledOnce();
    expect(document.getSelection()!.toString()).toBe('Alpha');
  });

  it('cancels a pending automatic save on host retirement without isolating later gestures', async () => {
    const annotate = vi.spyOn(f.store, 'annotate'),
      workspace = vi.fn();
    f.view.containerEl.addEventListener('touchmove', workspace);
    f.select(0);
    vi.advanceTimersByTime(899);
    f.signal.abort();
    document.dispatchEvent(new Event('selectionchange'));
    gesture('touchmove');
    vi.advanceTimersByTime(1200);
    await f.probe.operations;
    expect(annotate).not.toHaveBeenCalled();
    expect(workspace).toHaveBeenCalledOnce();
    expect(document.getSelection()!.toString()).toBe('Alpha');
  });

  it('saves 900ms after the last pointer releases, shows one transient acknowledgement, then paints without clearing native selection', async () => {
    vi.spyOn(f.surface.viewport, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 400, 300),
    );
    const descriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      writable: true,
      value: () => [new DOMRect(20, 20, 100, 20)],
    });
    const restoreGeometry = () => {
      if (descriptor) Object.defineProperty(Range.prototype, 'getClientRects', descriptor);
      else delete (Range.prototype as any).getClientRects;
    };
    try {
      const pointer = (type: string, pointerId: number) => {
        const event = new MouseEvent(type, { bubbles: true, button: 0 });
        Object.defineProperty(event, 'pointerId', { value: pointerId });
        f.surface.body.dispatchEvent(event);
      };
      pointer('pointerdown', 1);
      pointer('pointerdown', 2);
      f.select(0);
      vi.advanceTimersByTime(1000);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      pointer('pointerup', 1);
      vi.advanceTimersByTime(1000);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      pointer('pointerup', 2);
      vi.advanceTimersByTime(899);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      vi.advanceTimersByTime(1);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe('==Alpha== phrase.\n\nBeta phrase.');
      expect(document.getSelection()!.toString()).toBe('Alpha');
      const feedback = f.view.contentEl.querySelector<HTMLElement>('.reader-highlight-feedback')!;
      expect(feedback.hidden).toBe(false);
      expect(feedback.textContent).toBe('Highlight saved');
      expect(f.view.contentEl.querySelector('.reader-status')?.textContent).toBe('');
      expect(
        [...f.view.contentEl.querySelectorAll('[role="status"]')].filter(
          (node) => node.textContent === 'Highlight saved',
        ),
      ).toHaveLength(1);
      expect(f.surface.body.querySelector('mark')).toBeNull(); // Selection is still held, not forcibly repainted.
      document.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      expect(f.surface.body.querySelector('mark')?.textContent).toBe('Alpha');
      expect(f.surface.body.classList.contains('reader-highlight-fallback')).toBe(true);
      expect(feedback.hidden).toBe(true);
      expect(f.view.contentEl.querySelector('.reader-status')?.textContent).toBe('');
      expect(mocks.notice).not.toHaveBeenCalled();
    } finally {
      restoreGeometry();
    }
  });

  it.each(['code', 'ambiguous'] as const)(
    'quietly skips expected %s passive mapping rejection but retains explicit mapping errors',
    async (kind) => {
      const context = 'x '.repeat(65),
        unit = `${context}same words${context}`;
      const body = kind === 'code' ? '`literal code`' : `${unit}\n\n${unit}`;
      f.vault.bytes.set(f.article, createDocument({ type: 'article' }, body));
      await f.view.changed({ path: f.article.path });
      const range = document.createRange();
      if (kind === 'code') range.selectNodeContents(f.surface.body.querySelector('code')!);
      else {
        const node = f.surface.body.querySelector('p')!.firstChild!;
        range.setStart(node, context.length);
        range.setEnd(node, context.length + 10);
      }
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      const before = await f.vault.read(f.article),
        annotate = vi.spyOn(f.store, 'annotate');
      vi.advanceTimersByTime(900);
      await f.probe.operations;
      expect(await f.vault.read(f.article)).toBe(before);
      expect(annotate).not.toHaveBeenCalled();
      expect(mocks.notice).not.toHaveBeenCalled();
      await expect(f.probe.saveSelection()).rejects.toThrow('cannot be matched safely');
    },
  );

  it.each(['Keep', 'Delete', 'Next'])(
    'uses the real bottom %s action to advance, retaining recoverable trash semantics',
    async (label) => {
      const next = await f.note('Reading/Inbox/Z next.md');
      await f.view.openArticle(f.article.path, true);
      const original = await f.vault.read(f.article),
        originalPath = f.article.path;
      const click = (name: string) =>
        [...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button')]
          .find((button) => actionName(button) === name)!
          .click();
      click(label);
      await f.probe.operations;
      expect(f.view.file).toBe(next);
      expect(f.vault.trashed).toEqual(label === 'Delete' ? [originalPath] : []);
      if (label !== 'Delete') {
        expect(await f.vault.read(f.article)).toBe(original);
        expect(f.article.path).toBe(
          label === 'Keep' ? 'Reading/Treasury/Selection.md' : originalPath,
        );
      }
      click('Next');
      await f.probe.operations;
      expect(f.view.file).toBeUndefined(); // Last-article Next returns to the list.
      expect(f.view.contentEl.querySelector('.reader-list')).not.toBeNull();
    },
  );

  it('keeps the new Delete action behind the existing source guard', async () => {
    const external = createDocument({ type: 'article' }, 'Externally edited words.');
    f.vault.bytes.set(f.article, external);
    [...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button')]
      .find((button) => actionName(button) === 'Delete')!
      .click();
    await expect(f.probe.operations).rejects.toThrow();
    expect(f.view.file).toBe(f.article);
    expect(f.vault.trashed).toEqual([]);
    expect(await f.vault.read(f.article)).toBe(external);
    expect(mocks.notice).toHaveBeenCalled();
  });

  it('retains acquisition errors and Retry when an automatic highlight succeeds', async () => {
    f.vault.bytes.set(
      f.article,
      patchProperties(await f.vault.read(f.article), { error: 'Fetch failed' }),
    );
    await f.view.changed({ path: f.article.path });
    f.select(0);
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toContain('==Alpha==');
    const status = f.view.contentEl.querySelector('.reader-status')!;
    expect(status.textContent).toContain('Fetch failed');
    status.querySelector<HTMLButtonElement>('button')!.click();
    expect(f.host.ingestion.acquire).toHaveBeenLastCalledWith(f.article.path, true);
  });

  it('does not silence genuine passive write failures', async () => {
    vi.spyOn(f.vault, 'process').mockRejectedValueOnce(new Error('Disk write failed'));
    f.select(0);
    vi.advanceTimersByTime(900);
    await expect(f.probe.operations).rejects.toThrow('Disk write failed');
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
    expect(mocks.notice).toHaveBeenCalledWith('Disk write failed');
    expect(f.view.contentEl.querySelector('.reader-status')?.textContent).not.toBe(
      'Highlight saved',
    );
  });

  it.each(['operation', 'position', 'writing'] as const)(
    'does not let an old A job save B after the %s wait',
    async (wait) => {
      const entered = gate(),
        release = gate();
      if (wait === 'operation') {
        void f.probe.operation(async () => {
          entered.resolve();
          await release.promise;
        });
      } else if (wait === 'writing') {
        f.probe.writing = release.promise.finally(() => {
          f.probe.writing = undefined;
        });
        entered.resolve();
      } else {
        const position = f.store.position.bind(f.store);
        vi.spyOn(f.store, 'position').mockImplementation(async (...args) => {
          entered.resolve();
          await release.promise;
          return position(...args);
        });
        f.probe.persistPosition('position sentinel');
      }
      await entered.promise;
      f.select(0);
      vi.advanceTimersByTime(900);
      const oldJob = f.probe.operations;
      // Let the automatic action enter its position wait, if that is the blocked path.
      await Promise.resolve();
      await Promise.resolve();
      f.select(1); // B has not satisfied its own 900ms debounce.
      release.resolve();
      await oldJob;
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      vi.advanceTimersByTime(900);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe('Alpha phrase.\n\n==Beta== phrase.');
      if (wait === 'position')
        expect((await f.store.read(f.article.path)).properties.reading_position).toBe(
          'position sentinel',
        );
    },
  );

  it.each(['repeat', 'pointer', 'unreported'] as const)(
    'invalidates queued A on %s input even without a different delivered quote',
    async (kind) => {
      const entered = gate(),
        release = gate();
      void f.probe.operation(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      f.select(0);
      vi.advanceTimersByTime(900);
      const oldJob = f.probe.operations;
      if (kind === 'repeat') f.select(0); // Same text/context, but a new selection revision.
      if (kind === 'unreported') f.select(1, 4, false); // The native selectionchange task has not run yet.
      if (kind === 'pointer') {
        for (const type of ['pointerdown', 'pointerup']) {
          const event = new Event(type, { bubbles: true });
          Object.assign(event, { pointerId: 1, button: 0 });
          f.surface.body.dispatchEvent(event);
        }
      }
      release.resolve();
      await oldJob;
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      if (kind === 'unreported') document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(900);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe(
        kind === 'unreported'
          ? 'Alpha phrase.\n\n==Beta== phrase.'
          : '==Alpha== phrase.\n\nBeta phrase.',
      );
    },
  );

  it('rechecks supersession inside the final write transform and leaves the new selection intact', async () => {
    const entered = gate(),
      release = gate(),
      process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (file, update) => {
      entered.resolve();
      await release.promise;
      return process(file, update);
    });
    f.select(0);
    vi.advanceTimersByTime(900);
    const oldJob = f.probe.operations;
    await entered.promise;
    f.select(1);
    release.resolve();
    await oldJob;
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
    expect(document.getSelection()!.toString()).toBe('Beta');
    expect(mocks.notice).not.toHaveBeenCalled();
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toBe('Alpha phrase.\n\n==Beta== phrase.');
  });

  it.each(['body', 'replacement'] as const)(
    'binds the candidate to its original displayed source and file across a %s change',
    async (kind) => {
      f.select(0);
      if (kind === 'body')
        f.vault.bytes.set(
          f.article,
          createDocument({ type: 'article' }, 'Alpha phrase.\n\nExternal source.'),
        );
      else {
        const replacement = Object.setPrototypeOf({ path: f.article.path }, TFile.prototype);
        f.vault.files.set(f.article.path, replacement);
        f.vault.bytes.set(replacement, f.vault.bytes.get(f.article)!);
      }
      await f.view.changed({ path: f.article.path });
      const before = await f.vault.read(f.vault.file(f.article.path)!);
      vi.advanceTimersByTime(900);
      await f.probe.operations;
      expect(await f.vault.read(f.vault.file(f.article.path)!)).toBe(before);
    },
  );

  it('allows keyboard-style selection changes, own deferred rendering and overlapping adjustment', async () => {
    f.select(0);
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toBe('==Alpha== phrase.\n\nBeta phrase.');
    expect(f.surface.displayedBody).toBe(f.body);
    expect(document.getSelection()!.toString()).toBe('Alpha');
    f.select(0, 12);
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toBe('==Alpha phrase==.\n\nBeta phrase.');
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(f.surface.displayedBody).toBe('==Alpha phrase==.\n\nBeta phrase.');
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect([...f.surface.body.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
      'Alpha phrase',
    ]);
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it('preserves its own Stream promotion during an automatic highlight', async () => {
    const moved = await f.store.move(await f.store.read(f.article.path), 'Stream');
    await f.view.openArticle(moved.path);
    // The surface changed through real navigation; drive its real DOM handler.
    const node = f.probe.surface.body.querySelector('p').firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect(f.article.path).toBe('Reading/Inbox/Selection.md');
    expect((await f.store.read(f.article.path)).body).toBe('==Alpha== phrase.\n\nBeta phrase.');
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it('does not roll back an already-dispatched A write and gives B its own debounce', async () => {
    const dispatched = gate(),
      release = gate(),
      process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (file, update) => {
      const raw = await process(file, update);
      dispatched.resolve();
      await release.promise;
      return raw;
    });
    f.select(0);
    vi.advanceTimersByTime(900);
    const oldJob = f.probe.operations;
    await dispatched.promise;
    f.select(1);
    release.resolve();
    await oldJob;
    expect((await f.store.read(f.article.path)).body).toBe('==Alpha== phrase.\n\nBeta phrase.');
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toBe('==Alpha== phrase.\n\n==Beta== phrase.');
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it('still saves the captured close-time selection after an old queued job is invalidated', async () => {
    const entered = gate(),
      release = gate();
    void f.probe.operation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    f.select(0);
    vi.advanceTimersByTime(900);
    f.select(1);
    const closing = f.view.onClose();
    document.getSelection()!.removeAllRanges();
    release.resolve();
    await closing;
    expect((await f.store.read(f.article.path)).body).toBe('Alpha phrase.\n\n==Beta== phrase.');
    expect(mocks.notice).not.toHaveBeenCalled();
  });
});

describe('displayed source and deferred rendering', () => {
  it('rejects stale selection, passage, move, topic, trash and position actions while newer source is deferred', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', 'before ==words== after');
    await f.view.openArticle(article.path);
    const surface = f.probe.surface,
      old = f.probe.snapshot.body;
    surface.hold = true;
    const current = createDocument({ type: 'article' }, 'before ==new words== after');
    f.vault.bytes.set(article, current);
    await f.view.changed({ path: article.path });
    expect(surface.displayedBody).toBe(old);
    expect(f.probe.snapshot.body).toBe('before ==new words== after');
    const annotate = vi.spyOn(f.store, 'annotate'),
      move = vi.spyOn(f.store, 'move'),
      trash = vi.spyOn(f.store, 'trash'),
      position = vi.spyOn(f.store, 'position');
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    await expect(f.probe.saveSelection()).rejects.toThrow('Article text changed');
    surface.selectionValue = undefined;
    expect(() => f.probe.passageMenu(passages(old)[0], new MouseEvent('click'))).toThrow(
      'Article text changed',
    );
    mocks.choose.mockResolvedValue('Later');
    await expect(f.probe.move()).rejects.toThrow('Article text changed');
    await expect(f.probe.topics()).rejects.toThrow('Article text changed');
    await expect(f.probe.finish('delete')).rejects.toThrow('Article text changed');
    f.probe.persistPosition('words');
    await f.probe.positionWrite;
    expect(annotate).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    expect(position).not.toHaveBeenCalled();
    expect(await f.vault.read(article)).toBe(current);
    surface.hold = false;
    surface.refresh();
    expect(surface.displayedBody).toBe(f.probe.snapshot.body);
  });

  it('permits automatic range adjustment over its own deferred highlight markup only', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    await f.probe.saveSelection();
    expect(surface.displayedBody).toBe('before words after');
    surface.selectionValue = { quote: 'words after', before: 'before ', after: '' };
    await f.probe.saveSelection();
    expect((await f.store.read(article.path)).body).toBe('before ==words after==');
    expect(surface.displayedBody).toBe('before words after');
    f.vault.bytes.set(
      article,
      createDocument({ type: 'article' }, 'before ==words after== plus native text'),
    );
    await f.view.changed({ path: article.path });
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    await expect(f.probe.saveSelection()).rejects.toThrow('Article text changed');
    expect((await f.store.read(article.path)).body).toBe('before ==words after== plus native text');
  });

  it('captures the pending selection before an awaited close loses the native range', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    const closing = f.view.onClose();
    surface.selectionValue = undefined;
    await closing;
    expect((await f.store.read(article.path)).body).toBe('before ==words== after');
    expect(surface.dispose).toHaveBeenCalledOnce();
  });

  it('turns a deferred failure into a non-mutating Markdown escape and ignores errors from old surfaces', async () => {
    const f = await pluginFixture(),
      article = await f.note('Reading/Inbox/A.md'),
      other = await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(article.path);
    const surface = f.probe.surface;
    surface.hold = true;
    f.vault.bytes.set(article, createDocument({ type: 'article' }, 'new unrenderable body'));
    await f.view.changed({ path: article.path });
    mocks.renderError = new Error('Content is too large.');
    surface.hold = false;
    surface.refresh();
    expect(f.view.file).toBe(article);
    expect(f.probe.snapshot).toBeUndefined();
    expect(f.view.contentEl.textContent).toContain('Content is too large.');
    const position = vi.spyOn(f.store, 'position'),
      annotate = vi.spyOn(f.store, 'annotate');
    await f.plugin.edit(f.view, article);
    expect(f.leaf.setViewState).toHaveBeenLastCalledWith({
      type: 'markdown',
      state: { file: article.path, mode: 'source' },
      active: true,
    });
    expect(position).not.toHaveBeenCalled();
    expect(annotate).not.toHaveBeenCalled();
    mocks.renderError = undefined;
    await f.view.openArticle(other.path);
    surface.renderError(new Error('late old callback'));
    expect(f.view.file).toBe(other);
    expect(f.probe.snapshot).toBeDefined();
  });
});

describe('public article commands', () => {
  it('checks active Reader context without side effects, preserves Move/Topics, and keeps Markdown escape on failure', async () => {
    const f = await pluginFixture();
    const command = (id: string, checking = true) =>
      mocks.commands.get(id)!.checkCallback!(checking);
    for (const id of ['move', 'topics', 'open-markdown']) expect(command(id)).toBe(false);
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    for (const id of ['move', 'topics', 'open-markdown']) expect(command(id, false)).toBe(false);
    const article = await f.note('Reading/Inbox/Commands.md');
    await f.view.openArticle(article.path);
    const before = await f.vault.read(article);
    for (const id of ['move', 'topics', 'open-markdown']) expect(command(id)).toBe(true);
    expect(mocks.choose).not.toHaveBeenCalled();
    expect(mocks.topics).not.toHaveBeenCalled();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
    mocks.choose.mockResolvedValue('Later');
    command('move', false);
    await f.probe.operations;
    expect(article.path).toBe('Reading/Later/Commands.md');
    expect(await f.vault.read(article)).toBe(before);
    command('topics', false);
    await f.probe.operations;
    expect(mocks.topics).toHaveBeenCalledOnce();
    f.vault.bytes.set(article, '---\ntype: other\n---\nUnchanged authored words.');
    await f.view.changed({ path: article.path });
    expect(command('move')).toBe(false);
    expect(command('topics')).toBe(false);
    expect(command('open-markdown')).toBe(true);
    f.host.edit = (view: ReaderView, file: TFile) => f.plugin.edit(view, file);
    command('open-markdown', false);
    await f.probe.operations;
    await vi.waitFor(
      () =>
        expect(f.leaf.setViewState).toHaveBeenCalledWith({
          type: 'markdown',
          state: { file: article.path, mode: 'source' },
          active: true,
        }),
      { interval: 1 },
    );
    f.signal.abort();
    for (const id of ['move', 'topics', 'open-markdown']) expect(command(id)).toBe(false);
    f.view.stopForUnload();
  });
});

describe('public reading-list command and URI', () => {
  afterEach(() => vi.unstubAllGlobals());
  const invoke = (route: string) =>
    route === 'command'
      ? mocks.commands.get('open-reader')!.callback!()
      : mocks.protocols.get('obsidian-reader')!({ action: 'obsidian-reader', view: 'list' });

  it.each(['command', 'uri'])(
    'forces the library through the existing lifecycle, draining writes and cancelling navigation scopes (%s)',
    async (route) => {
      const f = await pluginFixture();
      const article = await f.note('Reading/Inbox/Article.md');
      await f.view.openArticle(article.path);
      vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
      expect(mocks.commands.get('open-reader')!.name).toBe('Open reading list');
      expect([...mocks.protocols.keys()]).toEqual(['obsidian-reader']);
      const pending = gate(),
        creation = new AbortController();
      f.probe.positionWrite = pending.promise;
      f.probe.nodeCreation = { controller: creation };
      f.probe.surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
      f.probe.surface.marker = 'words';
      invoke(route);
      expect(creation.signal.aborted).toBe(true);
      expect(f.view.file).toBe(article);
      pending.resolve();
      await f.probe.operations;
      expect(f.view.file).toBeUndefined();
      expect(f.view.contentEl.querySelector('.reader-list')).not.toBeNull();
      const saved = readDocument(await f.vault.read(article));
      expect(saved.body).toBe('before ==words== after');
      expect(saved.properties.reading_position).toBe('words');
      expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
    },
  );

  it.each(['command', 'uri'])(
    'keeps a failed source save mounted and reports it through the public %s route',
    async (route) => {
      const f = await pluginFixture();
      const article = await f.note('Reading/Inbox/Article.md');
      await f.view.openArticle(article.path);
      vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
      f.probe.surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
      const raw = createDocument({ type: 'article' }, 'New externally saved source');
      f.vault.bytes.set(article, raw);
      invoke(route);
      await expect(f.probe.operations).rejects.toThrow();
      await Promise.resolve();
      expect(f.view.file).toBe(article);
      expect(await f.vault.read(article)).toBe(raw);
      expect(mocks.notice).toHaveBeenCalled();
      expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
    },
  );

  it('opens a new library without replacing a dirty native editor or clearing its Markdown exemption', async () => {
    const f = await pluginFixture();
    const article = await f.note('Reading/Inbox/Native.md');
    const native = new MarkdownView(f.leaf),
      raw = await f.vault.read(article);
    const editor = { getValue: () => raw + '\nUnsaved native words' };
    Object.assign(native, { file: article, editor });
    f.leaf.view = native;
    f.vault.dirty.add(article);
    const exemption = { file: article, transitioning: false };
    f.pluginProbe.sourceLeaves.set(f.leaf, exemption);
    const leaf: any = { app: f.app, setViewState: vi.fn() };
    const reader = new ReaderView(leaf, f.plugin);
    leaf.view = reader;
    f.leaves.push(leaf);
    leaf.setViewState.mockImplementation(async (state: any) =>
      reader.setState(state.state, { history: false }),
    );
    vi.mocked(f.app.workspace.getLeaf).mockReturnValue(leaf);
    invoke('uri');
    await (reader as any).operations;
    expect(f.app.workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(leaf.setViewState).toHaveBeenCalledWith({
      type: 'obsidian-reader',
      state: {},
      active: true,
    });
    expect(reader.contentEl.querySelector('.reader-list')).not.toBeNull();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
    expect(f.leaf.view).toBe(native);
    expect(editor.getValue()).toBe(raw + '\nUnsaved native words');
    expect(await f.vault.read(article)).toBe(raw);
    expect(f.pluginProbe.sourceLeaves.get(f.leaf)).toBe(exemption);
  });

  it.each([undefined, '', 'article', 'List', 'unknown'])(
    'ignores unsupported URI view %s',
    async (view) => {
      const f = await pluginFixture();
      const open = vi.spyOn(f.plugin, 'openList');
      const params: Record<string, string> = { action: 'obsidian-reader' };
      if (view !== undefined) params.view = view;
      mocks.protocols.get('obsidian-reader')!(params);
      expect(open).not.toHaveBeenCalled();
      expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
    },
  );

  it('copies only on explicit command, encoding the current local vault name every time without reading the clipboard', async () => {
    const clipboard = { writeText: vi.fn(async (_text: string) => {}), readText: vi.fn() };
    vi.stubGlobal('navigator', { clipboard, onLine: false });
    const f = await pluginFixture();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(f.app.vault.getName).not.toHaveBeenCalled();
    const command = mocks.commands.get('copy-reading-list-link')!;
    expect(command.name).toBe('Copy reading-list link');
    for (const name of ['iPhone Reading & références / # 日本語', 'Boox local – 阅读']) {
      vi.mocked(f.app.vault.getName).mockReturnValue(name);
      await command.callback!();
      const link = clipboard.writeText.mock.calls.at(-1)![0];
      expect(link).toBe(`obsidian://obsidian-reader?vault=${encodeURIComponent(name)}&view=list`);
      const url = new URL(link);
      expect(url.protocol).toBe('obsidian:');
      expect(url.hostname).toBe('obsidian-reader');
      expect([...url.searchParams]).toEqual([
        ['vault', name],
        ['view', 'list'],
      ]);
      expect(url.hash).toBe('');
      expect(mocks.notice).toHaveBeenLastCalledWith('Reading-list link copied.');
    }
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
  });

  it.each(['unsupported', 'denied'])(
    'reports %s clipboard support without an unhandled error or navigation',
    async (mode) => {
      const writeText = vi.fn(async () => {
        throw new Error('Permission denied');
      });
      vi.stubGlobal('navigator', {
        clipboard: mode === 'unsupported' ? undefined : { writeText },
        onLine: false,
      });
      const f = await pluginFixture();
      await mocks.commands.get('copy-reading-list-link')!.callback!();
      expect(mocks.notice).toHaveBeenCalledWith(
        mode === 'unsupported'
          ? 'Clipboard is unavailable on this device. Reading-list link was not copied.'
          : 'Could not copy the reading-list link: Permission denied',
      );
      expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
    },
  );

  it('ignores late commands and URI callbacks after unload', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText }, onLine: false });
    const f = await pluginFixture();
    f.plugin.onunload();
    invoke('command');
    invoke('uri');
    await mocks.commands.get('copy-reading-list-link')!.callback!();
    expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
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
            reading_position: saved ? `Saved text from ${file.path}` : undefined,
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
        [...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button')]
          .find((button) => actionName(button) === route)!
          .click();
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
        expect(surface.canPage(direction)).toBe(false); // Buttons can already navigate here.
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
      let resize = () => {};
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: ResizeObserverCallback) {
            resize = () => callback([], this as unknown as ResizeObserver);
          }
          observe() {}
          disconnect() {}
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
    it('retains the confirmed endpoint through actual position writes and delayed scroll capture', async () => {
      f = await measuredFixture();
      const render = await import('../src/reader/render');
      vi.mocked(render.textBookmark).mockReturnValue('before words');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { surface, geometry, view, probe, store } = f;
      surface.viewport.scrollLeft = geometry.end - 4;
      surface.page(1); // Capture dispatches the real View.persistPosition -> ArticleStore write.
      await probe.positionWrite;
      expect((await store.read(f.b.path)).properties.reading_position).toBe('before words');
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
        expect((await store.read(f.c.path)).properties.reading_position).toBe('after');
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

describe('safe default article routing', () => {
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  async function fixture(type = 'article', path = 'Outside/Article.md') {
    const f = await pluginFixture();
    const file = await f.note(path, 'Authored body', type);
    const native = new MarkdownView(f.leaf);
    const editor = { getValue: vi.fn(() => f.vault.bytes.get(file)!) };
    Object.assign(native, { file, editor });
    (file as any).stat = { mtime: 1, ctime: 1, size: f.vault.bytes.get(file)!.length };
    f.leaf.view = native;
    vi.mocked(f.app.workspace.getActiveViewOfType).mockImplementation((constructor: any) =>
      f.leaf.view instanceof constructor ? f.leaf.view : null,
    );
    f.leaf.setViewState.mockImplementation(async (state: any) => {
      if (state.type === 'obsidian-reader') f.leaf.view = f.view;
    });
    return { ...f, file, native, editor };
  }
  it.each(['article', 'Project', 'PhoneTask', 'note', 'Article'])(
    'routes only exact real type: article, including outside queues (%s)',
    async (type) => {
      const f = await fixture(type);
      const raw = await f.vault.read(f.file);
      f.workspace('file-open', f.file);
      await settle();
      if (type === 'article')
        expect(f.leaf.setViewState).toHaveBeenCalledExactlyOnceWith({
          type: 'obsidian-reader',
          state: { file: f.file.path },
        });
      else expect(f.leaf.setViewState).not.toHaveBeenCalled();
      expect(await f.vault.read(f.file)).toBe(raw);
    },
  );
  it('does not classify a folder name or stale cached article type as article', async () => {
    const f = await fixture('Project', 'Reading/Inbox/Project.md');
    f.cache.get(f.file).frontmatter.type = 'article';
    f.workspace('file-open', f.file);
    f.metadata('changed', f.file);
    await settle();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
  });
  it('can route from fresh bytes despite missing metadata; deferred editor/metadata readiness retries safely', async () => {
    const f = await fixture();
    f.cache.delete(f.file);
    f.editor.getValue.mockReturnValue('');
    f.workspace('file-open', f.file);
    await settle();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
    f.editor.getValue.mockReturnValue(f.vault.bytes.get(f.file)!);
    f.metadata('changed', f.file);
    await settle();
    expect(f.leaf.setViewState).toHaveBeenCalledOnce();
    f.metadata('changed', f.file);
    f.workspace('active-leaf-change', f.leaf);
    await settle();
    expect(f.leaf.setViewState).toHaveBeenCalledOnce();
  });
  it.each([
    'dirty',
    'missing-editor',
    'throwing-editor',
    'modal',
    'property-field',
    'property-title',
    'selection',
  ])('never replaces an uncertain native editor (%s)', async (condition) => {
    const f = await fixture();
    if (condition === 'dirty') f.editor.getValue.mockReturnValue('Unsaved native changes');
    if (condition === 'missing-editor') (f.native as any).editor = undefined;
    if (condition === 'throwing-editor')
      f.editor.getValue.mockImplementation(() => {
        throw new Error('not ready');
      });
    if (condition === 'modal') document.body.createDiv({ cls: 'modal-container' });
    if (condition === 'property-field') document.body.createEl('input').focus();
    if (condition === 'property-title') {
      const title = document.body.createDiv({ attr: { contenteditable: 'true', tabindex: '0' } });
      title.focus();
    }
    if (condition === 'selection') {
      const text = document.body.createEl('p', { text: 'Native selected words' });
      const range = document.createRange();
      range.selectNodeContents(text);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      expect(document.getSelection()!.isCollapsed).toBe(false);
    }
    f.workspace('file-open', f.file);
    await settle();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
    expect(f.leaf.view).toBe(f.native);
  });
  it('can route a focused native source editor once its public bytes are proven clean', async () => {
    const f = await fixture();
    const editor = document.body.createDiv({ attr: { contenteditable: 'true', tabindex: '0' } });
    editor.focus();
    Object.assign(f.editor, { hasFocus: () => true });
    f.workspace('file-open', f.file);
    await settle();
    expect(f.leaf.setViewState).toHaveBeenCalledOnce();
  });
  it.each([
    'dirty',
    'file-change',
    'replace',
    'rename',
    'revision',
    'background',
    'round-trip',
    'unload',
  ])('rejects a deferred routing result after %s', async (condition) => {
    const f = await fixture();
    const raw = f.vault.bytes.get(f.file)!;
    const started = gate(),
      release = gate();
    vi.spyOn(f.vault, 'read').mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return raw;
    });
    f.workspace('file-open', f.file);
    await started.promise;
    if (condition === 'dirty') f.editor.getValue.mockReturnValue(raw + '\nUnsaved');
    if (condition === 'file-change')
      (f.native as any).file = await f.note('Notes/Other.md', '', 'Project');
    if (condition === 'replace') f.vault.files.set(f.file.path, {} as any);
    if (condition === 'rename') f.file.path = 'Outside/Renamed.md';
    if (condition === 'revision') f.file.stat.mtime++;
    if (condition === 'background' || condition === 'round-trip') {
      vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(null);
      f.workspace('active-leaf-change', null);
      if (condition === 'round-trip')
        vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.native);
    }
    if (condition === 'unload') f.plugin.onunload();
    release.resolve();
    await settle();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
  });
  it('preserves explicit Markdown intent across metadata and active-leaf events without persisting view state', async () => {
    const f = await fixture();
    f.leaf.view = f.view;
    await f.view.openArticle(f.file.path);
    f.leaf.setViewState.mockImplementation(async () => {
      f.leaf.view = f.native;
      f.workspace('file-open', f.file);
    });
    await f.plugin.edit(f.view, f.file);
    f.metadata('changed', f.file);
    f.metadata('resolve', f.file);
    f.workspace('active-leaf-change', f.leaf);
    await settle();
    expect(f.leaf.setViewState).toHaveBeenCalledExactlyOnceWith({
      type: 'markdown',
      state: { file: f.file.path, mode: 'source' },
      active: true,
    });
    expect(f.view.getState()).toEqual({ file: f.file.path, queue: 'Inbox' });
  });
});

describe('bounded Reader UI', () => {
  it('keeps library titles as text, with four bottom actions and no search/subtitles/Treasury/Feeds buttons', async () => {
    const f = hostFixture();
    await f.note('Reading/Inbox/Visible title.md');
    f.view.showList();
    const buttons = [
      ...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-toolbar button'),
    ];
    expect(buttons.map(actionName)).toEqual(['Inbox', 'Later', 'Stream', 'Add URL']);
    expect(buttons.map((button) => button.querySelector('svg')?.getAttribute('data-icon'))).toEqual(
      ['inbox', 'clock', 'waves', 'plus'],
    );
    for (const button of buttons) {
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(setTooltip).toHaveBeenCalledWith(button, actionName(button));
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
    more.click();
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(51);
    expect(f.view.contentEl.querySelector('[aria-label="Show more"]')).toBeNull();
  });

  it('opens Treasury through the palette, resets old search, and preserves Treasury/feed bytes and feeds access', async () => {
    const f = await pluginFixture();
    const saved = await f.note('Reading/Treasury/Saved title.md', 'Authored Treasury body');
    const feed = await f.note('Reading/Wires/Feed.md', 'Authored subscription notes', 'feed');
    const before = [await f.vault.read(saved), await f.vault.read(feed)];
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    f.probe.search = 'Unrelated old search';
    f.probe.listLimit = 150;
    const command = mocks.commands.get('open-treasury')!;
    expect(command.name).toBe('Open Treasury');
    command.callback!();
    await f.probe.operations;
    expect(f.view.getState().queue).toBe('Treasury');
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

  it('opens a new Treasury view through the same public workspace route when no Reader is active', async () => {
    const f = await pluginFixture();
    vi.mocked(f.app.workspace.getLeaf).mockReturnValue(f.leaf);
    f.leaf.setViewState.mockImplementation(async (state: any) =>
      f.view.setState(state.state, { history: false }),
    );
    await f.plugin.openList('Treasury');
    expect(f.app.workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(f.leaf.setViewState).toHaveBeenCalledWith({
      type: 'obsidian-reader',
      state: { queue: 'Treasury' },
      active: true,
    });
    expect(f.view.getState().queue).toBe('Treasury');
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

  it('shares the library action treatment with five uniform article icons, without hiding authored hr or modal controls', async () => {
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
      ).toEqual(['chevron-left', 'chevron-right', 'bookmark', 'trash-2', 'list']);
      expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
        'Previous article',
        'Next article',
        'Keep article and advance',
        'Trash article and advance',
        'List',
      ]);
      expect(buttons[0].disabled).toBe(true);
      for (const button of buttons) {
        const css = window.getComputedStyle(button);
        expect(button.textContent).toBe('');
        expect(css.minWidth).toBe('44px');
        expect(css.minHeight).toBe('44px');
        expect([css.padding, css.borderRadius, css.backgroundColor, css.border]).toEqual(treatment);
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
      expect(rule('.reader-list-title').getPropertyValue('min-width')).toBe('0');
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
      expect(rowStyle.borderRadius).toBe('0');
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
      expect(actions).toHaveLength(5);
      for (const button of actions) checkIcon(button, '100%');
      expect(actions[0].disabled).toBe(true);
      expect(window.getComputedStyle(actions[0]).opacity).toBe('0.45');
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
      expect(await f.vault.read(article)).toBe(raw);
    } finally {
      host.remove();
      reader.remove();
    }
  });
});

describe('leaf-scoped floating Reader layout', () => {
  it.each([390, 1280].flatMap((width) => [false, true].map((paged) => ({ width, paged }))))(
    'uses full-pane CSS with compact 4/5-action overlays (width=$width, paged=$paged)',
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
        expect(library.querySelectorAll('button')).toHaveLength(4);
        expect(window.getComputedStyle(library).position).toBe('absolute');
        expect(window.getComputedStyle(f.view.contentEl).position).toBe('relative');
        expect(window.getComputedStyle(list).flex).toBe('1 1 auto');
        expect(f.view.contentEl.querySelector('input[type="search"],small')).toBeNull();
        expect(list.textContent).toBe('Full authored title');
        await f.view.openArticle(file.path, true);
        const column = f.view.contentEl.querySelector('.reader-article')!;
        const actions = column.querySelector('.reader-bottom-controls')!;
        expect(actions.querySelectorAll('button')).toHaveLength(5);
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
        expect(await f.vault.read(file)).toBe(raw);
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
      f.view.showList('Stream');
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
        reading_position: position,
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
      f.view.showList('Stream');
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
    f.view.showList('Stream');
    const oldRows = [...f.view.contentEl.querySelectorAll('.reader-list-item')];
    observers[0].intersect(oldRows.slice(0, 3));
    expect(reads).toHaveBeenCalledTimes(2);
    f.view.showList('Stream');
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
        raw = patchProperties(f.vault.bytes.get(f.files[0])!, { reading_position: 'words' });
      f.vault.bytes.set(f.files[0], raw);
      f.files[0].stat.size = raw.length;
      vi.spyOn(f.vault, 'read').mockImplementationOnce(async () => {
        await release.promise;
        return raw;
      });
      f.view.showList('Stream');
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
    f.view.showList('Stream');
    const row = f.view.contentEl.querySelector('.reader-list-item')!;
    observers[0].intersect([row]);
    await settle();
    expect(row.textContent).toBe('0 Visible');
    expect(row.querySelector('.reader-highlight-indicator')).toBeNull();
    expect(mocks.notice).not.toHaveBeenCalled();
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: undefined });
    reads.mockClear();
    f.view.showList('Stream');
    expect(reads).not.toHaveBeenCalled();
    expect(f.view.contentEl.querySelector('.reader-list-item')?.textContent).toBe('0 Visible');
  });
});

describe('native title-only presentation', () => {
  it('refreshes cloned state without history, remounting, or prefixing the article heading', async () => {
    const f = hostFixture(),
      file = await f.note('Reading/Inbox/A.md');
    f.host.refreshPresentation = () =>
      f.leaf.setViewState({ type: READER_VIEW, state: { readerPresentationOnly: true } });
    f.leaf.setViewState.mockImplementation(async ({ state }: any) => {
      const result = { history: true };
      await f.view.setState(JSON.parse(JSON.stringify(state)), result);
      expect(result.history).toBe(false);
    });
    await f.view.openArticle(file.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    const selection = surface.selectionValue;
    expect(f.view.getDisplayText()).toBe('Reader: A');
    f.vault.bytes.set(file, patchProperties(await f.vault.read(file), { title: 'External title' }));
    await f.view.changed({ path: file.path });
    expect(f.view.getDisplayText()).toBe('Reader: External title');
    expect(surface.title.textContent).toBe('External title');
    expect(f.probe.surface).toBe(surface);
    expect(surface.dispose).not.toHaveBeenCalled();
    expect(surface.selectionValue).toBe(selection);
    expect(f.view.getState()).not.toHaveProperty('readerPresentationOnly');
    surface.selectionValue = undefined;
    await f.view.readingList();
    expect(f.view.getDisplayText()).toBe('Reading list');
  });
  it('never replays an old article or swallows navigation when delayed title requests arrive', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md');
    const requests: { state: Record<string, unknown>; done: ReturnType<typeof gate> }[] = [];
    f.host.refreshPresentation = () =>
      f.leaf.setViewState({ type: READER_VIEW, state: { readerPresentationOnly: true } });
    f.leaf.setViewState.mockImplementation(({ state }: any) => {
      const done = gate();
      requests.push({ state: JSON.parse(JSON.stringify(state)), done });
      return done.promise;
    });
    await f.view.openArticle(a.path);
    await f.view.setState({ file: b.path, queue: 'Inbox' }, { history: false });
    const surface = f.probe.surface;
    expect(requests).toHaveLength(2);
    for (const request of requests.reverse()) {
      const result = { history: true };
      await f.view.setState(request.state, result);
      request.done.resolve();
      expect(result.history).toBe(false);
      expect(f.view.file).toBe(b);
      expect(f.probe.surface).toBe(surface);
    }
    expect(surface.dispose).not.toHaveBeenCalled();
    expect(f.view.getDisplayText()).toBe('Reader: B');
    expect(f.view.getState()).toEqual({ file: b.path, queue: 'Inbox' });
  });
});

describe('browsing context and presentation', () => {
  it('uses independent folder context for Stream promotion, browsing and explicit Keep', async () => {
    const folders: ReaderFolders = {
      inbox: 'Queues/Inbox',
      stream: 'Cache/Stream',
      later: 'Queues/Later',
      treasury: 'Archive/Books',
      feeds: 'Subscriptions',
    };
    const f = hostFixture(folders);
    const a = await f.note(`${folders.stream}/A.md`, '==Preserve this=='),
      b = await f.note(`${folders.stream}/B.md`, 'Next article');
    const rawA = f.vault.bytes.get(a),
      rawB = f.vault.bytes.get(b);
    f.view.showList('Stream');
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(2);
    expect(a.path).toBe('Cache/Stream/A.md');
    await f.view.openArticle(a.path, true);
    expect(a.path).toBe('Queues/Inbox/A.md');
    expect(f.view.getDisplayText()).toBe('Reader: A');
    await f.probe.finish('next');
    expect(f.view.file).toBe(b);
    await f.probe.finish('keep');
    expect(b.path).toBe('Archive/Books/B.md');
    expect(f.vault.bytes.get(a)).toBe(rawA);
    expect(f.vault.bytes.get(b)).toBe(rawB);
  });
  it('snapshots every matching search result, excluding unrelated and later-arriving articles', async () => {
    const f = hostFixture();
    for (let index = 0; index < 62; index++)
      await f.note(
        `Reading/Inbox/${String(index).padStart(2, '0')} ${index === 1 ? 'Other' : 'Match'}.md`,
      );
    f.probe.search = 'Match';
    f.view.showList('Inbox');
    const matching = f.store.catalog
      .list('Inbox', 'Match', 0, f.store.catalog.size)
      .map((article) => article.path);
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(50);
    await f.view.openArticle(matching[49], true);
    const late = await f.note('Reading/Inbox/Late Match.md');
    await f.view.navigate(1);
    expect(f.view.file?.path).toBe(matching[50]);
    expect(f.probe.readingQueue.paths).toEqual(matching);
    expect(f.probe.readingQueue.paths).not.toContain(late.path);
  });

  it('requests public layout saves and updates its own visible title on navigation, rename and list return', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(a.path);
    expect(f.view.contentEl.querySelector('h1')?.textContent).toBe('A');
    await f.view.openArticle(b.path);
    expect(f.view.getState()).toEqual({ file: b.path, queue: 'Inbox' });
    expect(f.view.getDisplayText()).toBe('Reader: B');
    expect(f.view.contentEl.querySelector('h1')?.textContent).toBe('B');
    expect(f.app.workspace.requestSaveLayout).toHaveBeenCalledTimes(2);
    f.probe.persistPosition('words');
    await f.probe.positionWrite;
    expect(f.app.workspace.requestSaveLayout).toHaveBeenCalledTimes(2);
    const old = b.path;
    await f.vault.move(b, 'Reading/Inbox/Renamed.md');
    await f.view.changed({ path: b.path, previousPath: old });
    expect(f.view.contentEl.querySelector('h1')?.textContent).toBe('Renamed');
    expect(f.view.getState().file).toBe(b.path);
    await f.view.readingList();
    expect(f.view.getState().file).toBeUndefined();
    expect(f.app.workspace.requestSaveLayout).toHaveBeenCalledTimes(4);
  });

  it.each([
    'before ==words== after',
    'before [[Notes/Target]] after',
    'before [words](/Notes/Target.md) after',
    '> ==first\n> second==',
    '- ==first\n  second==',
    '> ==first\r\n> second==',
    '- ==first\r\n  second==',
  ])(
    'promotes a fresh Stream article on open from its already-read annotations: %s',
    async (body) => {
      const f = hostFixture(),
        a = await f.note('Reading/Stream/A.md', body),
        b = await f.note('Reading/Stream/B.md');
      f.view.showList('Stream');
      const move = vi.spyOn(f.store, 'move'),
        enumerate = vi.spyOn(f.app.vault, 'getMarkdownFiles');
      await f.view.openArticle(a.path, true);
      expect(move).toHaveBeenCalledWith(expect.objectContaining({ body }), 'Inbox');
      expect(enumerate).not.toHaveBeenCalled();
      expect(a.path).toBe('Reading/Inbox/A.md');
      expect((await f.store.read(a.path)).body).toBe(body);
      expect(f.view.getState().queue).toBe('Stream');
      await f.view.navigate(1);
      expect(f.view.file).toBe(b);
    },
  );

  it.each([
    { properties: { related: '[[Topics/X.md]]' }, kept: true },
    { properties: { related: { nested: ['[[Topics/X.md]]'] } }, kept: true },
    {
      properties: { feed: '[[Reading/Wires/Feed.md]]', reading_position: 'quote:[[Topics/X.md]]' },
      kept: false,
    },
  ])(
    'checks authored YAML links, not feed/position values, when opening Stream: %j',
    async ({ properties, kept }) => {
      const f = hostFixture(),
        file = await f.note('Reading/Stream/Article.md');
      const raw = await f.vault.process(file, (current) => patchProperties(current, properties));
      await f.view.openArticle(file.path);
      expect(file.path).toBe(`Reading/${kept ? 'Inbox' : 'Stream'}/Article.md`);
      expect(await f.vault.read(file)).toBe(raw);
    },
  );

  it('retains and reports a failed open-time promotion without losing the origin queue', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Stream/A.md', '==keep=='),
      b = await f.note('Reading/Stream/B.md');
    f.view.showList('Stream');
    f.vault.failMove = true;
    await f.view.openArticle(a.path, true);
    expect(f.view.file).toBe(a);
    expect(a.path).toBe('Reading/Stream/A.md');
    expect(f.probe.surface.displayedBody).toBe('==keep==');
    expect(mocks.notice).toHaveBeenCalledWith('Move failed');
    expect(f.vault.trashed).toEqual([]);
    await f.view.navigate(1);
    expect(f.view.file).toBe(b);
  });
});

describe('commit-time annotation targets', () => {
  function sharedPicker(f: ReturnType<typeof hostFixture>, target: TFile, wait = async () => {}) {
    const node: NodeResult = {
      path: target.path,
      title: 'Target',
      type: 'topic',
      classes: ['topic'],
      aliases: [],
    };
    const api: NodesApi = {
      version: 2,
      listTypes: () => [],
      searchNodes: () => [node],
      getNode: () => node,
      createNode: vi.fn(async () => null),
      pickNodeForLink: async (_options, link) => {
        await wait();
        await link(node);
        return node;
      },
    };
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
  }
  it('allows a position save while a link picker is open without losing the annotation', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', '==words=='),
      target = await f.note('Notes/Target.md', '', 'topic');
    await f.view.openArticle(article.path);
    const started = gate(),
      finish = gate();
    sharedPicker(f, target, async () => {
      started.resolve();
      await finish.promise;
    });
    const linking = menu(f.view, 'Link to note…');
    await started.promise;
    f.probe.persistPosition('words');
    await f.probe.positionWrite;
    finish.resolve();
    await linking;
    expect((await f.store.read(article.path)).body).toBe('==[[Notes/Target.md|words]]==');
    expect((await f.store.read(article.path)).properties.reading_position).toBe('words');
  });

  it('rejects a selected note replaced at the same path after preflight validation', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', '==words=='),
      target = await f.note('Notes/Target.md', '', 'topic');
    await f.view.openArticle(article.path);
    sharedPicker(f, target);
    const original = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
      f.vault.files.set(target.path, { path: target.path });
      return original(file, transform);
    });
    await expect(menu(f.view, 'Link to note…')).rejects.toThrow('selected note changed');
    expect((await f.store.read(article.path)).body).toBe('==words==');
  });

  it.each(['api', 'classes', 'file', 'swap'] as const)(
    'rechecks Nodes %s inside the actual commit',
    async (kind) => {
      const f = hostFixture(),
        article = await f.note('Reading/Inbox/A.md', '==words=='),
        target = await f.note('Nodes/One.md', '', 'topic');
      const node = {
        path: target.path,
        type: 'topic',
        classes: ['topic'],
        title: 'One',
        aliases: [],
      };
      const api = {
        version: 2,
        listTypes: () => [],
        searchNodes: () => [node],
        getNode: () => node,
        createNode: async () => node,
        pickNodeForLink: async (_options: unknown, link: (node: NodeResult) => Promise<void>) => {
          await link({ ...node });
          return node;
        },
      };
      let current: unknown = api;
      (f.app as any).plugins = { getPlugin: () => ({ api: current }) };
      await f.view.openArticle(article.path);
      const original = f.vault.process.bind(f.vault);
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
        if (kind === 'api') current = { ...api };
        else if (kind === 'classes') node.classes = ['person'];
        else if (kind === 'file') f.vault.files.delete(target.path);
        else f.vault.files.set(target.path, { path: target.path });
        return original(file, transform);
      });
      await expect(menu(f.view, 'Link to note…')).rejects.toThrow(/selected (node|note)/);
      expect((await f.store.read(article.path)).body).toBe('==words==');
    },
  );

  it('resolves short native topic links and preserves their authored spelling', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md'),
      target = await f.note('Topics/Short topic name.md', '', 'topic');
    f.vault.bytes.set(
      article,
      createDocument({ type: 'article', topics: ['[[Short topic name|My label]]'] }, 'body'),
    );
    vi.mocked(f.app.metadataCache.getFirstLinkpathDest).mockImplementation((path, source) => {
      expect(source).toBe(article.path);
      return path === 'Short topic name' ? target : null;
    });
    await f.view.openArticle(article.path);
    mocks.topics.mockResolvedValue([target.path]);
    await f.probe.topics();
    expect(mocks.topics.mock.calls[0][2]).toEqual(new Set([target.path]));
    expect((await f.store.read(article.path)).properties.topics).toEqual([
      '[[Short topic name|My label]]',
    ]);
  });

  it.each([
    { topics: ['unrecognized'] },
    { topics: ['[[Missing]]'] },
    { topics: [42] },
    { topics: 'not an array' },
  ])('fails closed on unrecognized/unresolved topic data: $topics', async ({ topics }) => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md');
    const original = createDocument({ type: 'article', topics }, 'body');
    f.vault.bytes.set(article, original);
    await f.view.openArticle(article.path);
    await expect(f.probe.topics()).rejects.toThrow(/Markdown/);
    expect(mocks.topics).not.toHaveBeenCalled();
    expect(await f.vault.read(article)).toBe(original);
  });

  it('retains an article promoted before a link target disappears, without saving the stale link', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Stream/A.md', '==words=='),
      target = await f.note('Notes/Target.md', '', 'topic');
    await f.view.openArticle(article.path);
    sharedPicker(f, target);
    // Opening now promotes preexisting annotations. Explicitly move back to Stream
    // to exercise the later annotation's own move-first partial-failure boundary.
    f.probe.snapshot = await f.store.move(await f.store.read(article.path), 'Stream');
    f.vault.beforeMove = async () => {
      f.vault.files.delete(target.path);
    };
    await expect(menu(f.view, 'Link to note…')).rejects.toThrow('selected note changed');
    expect(article.path).toBe('Reading/Inbox/A.md');
    expect((await f.store.read(article.path)).body).toBe('==words==');
  });

  it('rechecks topic identity and type at commit time', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md'),
      target = await f.note('Topics/One.md', '', 'topic');
    await f.view.openArticle(article.path);
    mocks.topics.mockResolvedValue([target.path]);
    const original = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
      f.cache.set(target, { frontmatter: { type: 'person' } });
      return original(file, transform);
    });
    await expect(f.probe.topics()).rejects.toThrow('topic changed');
    expect((await f.store.read(article.path)).properties.topics).toBeUndefined();
  });

  it('preserves rich words when unlinking a Markdown-linked highlight', async () => {
    const f = hostFixture(),
      article = await f.note(
        'Reading/Inbox/A.md',
        '==[**formatted words**](/Notes/URI%20Path.md)==',
      );
    await f.view.openArticle(article.path);
    await menu(f.view, 'Remove link (keeps highlight)');
    expect((await f.store.read(article.path)).body).toBe('==**formatted words**==');
  });
});

describe('Nodes v2 linked creation', () => {
  async function fixture(body = '==words==') {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', body),
      target = await f.note('Nodes/One.md', 'Keep this created note', 'topic');
    const node: NodeResult = {
      path: target.path,
      title: 'One',
      type: 'topic',
      classes: ['topic', 'Other'],
      aliases: [],
    };
    const api: NodesApi = {
      version: 2,
      listTypes: vi.fn(() => []),
      searchNodes: vi.fn(() => [node]),
      // Discovery's last-bound type legitimately differs from creation's chosen class.
      getNode: vi.fn(() => ({ ...node, type: 'Other', classes: [...node.classes] })),
      createNode: vi.fn(async () => node),
      pickNodeForLink: vi.fn(async (_options, link) => {
        await link(node);
        return node;
      }),
    };
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    await f.view.openArticle(article.path);
    return { ...f, article, target, node, api };
  }
  const linkedBody = '==[[Nodes/One.md|words]]==';
  const originalLinkedBody = '==[[Notes/Existing.md|words]]==';
  async function uiFixture() {
    const f = await fixture(originalLinkedBody);
    await f.note('Reading/Inbox/0.md');
    await f.note('Reading/Inbox/B.md');
    await f.note('Notes/Existing.md', 'Keep existing note', 'topic');
    f.host.paged = true;
    await f.view.onOpen(); // Install Reader's actual DOM handlers, not calls to private navigation.
    await f.view.openArticle(f.article.path, true);
    const plugin = new ReaderPlugin(f.app, {} as any);
    (plugin as any).app = f.app;
    await plugin.onload();
    plugin.store = f.store;
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    f.host.edit = vi.fn((view: ReaderView, file: TFile) => plugin.edit(view, file));
    const web = vi.spyOn(window, 'open').mockReturnValue(null);
    async function click(route: string, label: string) {
      if (route === 'command') {
        const id = { 'Move…': 'move', 'Topics…': 'topics', 'Open Markdown': 'open-markdown' }[
          label
        ];
        const command = mocks.commands.get(id!);
        expect(command?.checkCallback?.(true)).toBe(true);
        expect(command?.checkCallback?.(false)).toBe(true);
      } else if (route === 'menu') {
        f.probe.surface.body.innerHTML = '<mark>words</mark>';
        f.probe.surface.body
          .querySelector('mark')
          .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        const action = mocks.menus.at(-1)!.get(label);
        expect(action).toBeTypeOf('function');
        action!();
      } else if (route === 'link') {
        const anchor = document.createElement('a');
        anchor.setAttribute(
          'href',
          label === 'external'
            ? 'https://example.test/article'
            : label === 'heading'
              ? '#section'
              : label === 'unsafe'
                ? 'javascript%3Aalert(1)'
                : f.target.path,
        );
        if (label !== 'external' && label !== 'heading') anchor.classList.add('internal-link');
        f.probe.surface.body.append(anchor);
        anchor.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            ctrlKey: label === 'new-leaf',
          }),
        );
      } else {
        const parent: HTMLElement = route === 'fallback' ? f.view.contentEl : f.probe.actions;
        const button = [...parent.querySelectorAll('button')].find(
          (button) => actionName(button) === label,
        );
        expect(button).toBeDefined();
        expect(button!.disabled).toBe(false);
        button!.click();
      }
      // Only drain the resulting work after the synchronous event handler has run.
      await Promise.resolve();
    }
    return { ...f, click, web };
  }

  it.each(
    [true, false].flatMap((linked) => [true, false].map((integrated) => ({ linked, integrated }))),
  )(
    'shows the approved note-only menu order (linked=$linked, Nodes=$integrated)',
    async ({ linked, integrated }) => {
      const f = await fixture(linked ? linkedBody : '==words==');
      if (!integrated) (f.app as any).plugins = undefined;
      await f.view.onOpen();
      try {
        await f.view.openArticle(f.article.path, true);
        f.probe.surface.body.innerHTML = '<mark>words</mark>';
        f.probe.surface.body
          .querySelector('mark')
          .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect([...mocks.menus.at(-1)!.keys()]).toEqual([
          ...(linked ? ['Open note'] : []),
          ...(integrated ? [linked ? 'Change link…' : 'Link to note…', 'Create note…'] : []),
          '---',
          ...(linked ? ['Remove link (keeps highlight)'] : []),
          'Remove highlight',
        ]);
      } finally {
        f.view.stopForUnload();
      }
    },
  );

  it.each(['Link to note…', 'Change link…', 'Create note…'])(
    'uses the shared seeded picker for %s',
    async (label) => {
      const f = await fixture(label === 'Change link…' ? originalLinkedBody : '==words==');
      await menu(f.view, label);
      expect(f.api.pickNodeForLink).toHaveBeenCalledWith(
        { suggestedTitle: 'words', sourcePath: f.article.path, signal: expect.any(AbortSignal) },
        expect.any(Function),
      );
      expect(mocks.choose).not.toHaveBeenCalled();
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect((await f.store.read(f.article.path)).body).toBe(linkedBody);
    },
  );

  it.each(['Link to note…', 'Create note…'])(
    'cancels the shared picker without a write: %s',
    async (label) => {
      const f = await fixture(),
        before = await f.vault.read(f.article);
      f.api.pickNodeForLink = vi.fn(async () => null);
      await menu(f.view, label);
      expect(await f.vault.read(f.article)).toBe(before);
      expect(f.vault.trashed).toEqual([]);
      expect(f.probe.dialog).toBe(false);
    },
  );

  it('preserves stale-source checks across the shared picker', async () => {
    const f = await fixture(),
      changed = createDocument({ type: 'article' }, '==new words==');
    f.api.pickNodeForLink = async (_options, link) => {
      f.vault.bytes.set(f.article, changed);
      await link(f.node);
      return f.node;
    };
    await expect(menu(f.view, 'Link to note…')).rejects.toThrow();
    expect(await f.vault.read(f.article)).toBe(changed);
    expect(f.vault.trashed).toEqual([]);
  });

  it.each(['Remove link (keeps highlight)', 'Remove highlight'])(
    'never removes or rewrites the linked file through %s',
    async (label) => {
      const f = await fixture(linkedBody),
        targetBefore = await f.vault.read(f.target);
      await menu(f.view, label);
      expect((await f.store.read(f.article.path)).body).toBe(
        label === 'Remove highlight' ? 'words' : '==words==',
      );
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(await f.vault.read(f.target)).toBe(targetBefore);
      expect(f.vault.trashed).toEqual([]);
    },
  );

  it.each([
    ['topic', 'Other'],
    ['Other', 'topic'],
    ['Other', 'topic', 'Extra'],
  ])(
    'links an existing node by class membership, not primary type or class order (%j)',
    async (...classes) => {
      const f = await fixture();
      f.api.getNode = () => ({ ...f.node, type: 'Other', classes });
      await menu(f.view, 'Link to note…');
      expect((await f.store.read(f.article.path)).body).toBe(linkedBody);
    },
  );

  it.each(['Inbox', 'Stream'] as const)(
    'commits directly before required completion without self-cancellation or a second link (%s)',
    async (queue) => {
      const f = await fixture(),
        entered = gate(),
        complete = gate(),
        order: string[] = [];
      if (queue === 'Stream')
        f.probe.snapshot = await f.store.move(await f.store.read(f.article.path), 'Stream');
      const annotate = vi.spyOn(f.store, 'annotate'),
        process = f.vault.process.bind(f.vault),
        move = f.vault.move.bind(f.vault);
      vi.spyOn(f.vault, 'move').mockImplementation(async (file, path) => {
        const previousPath = file.path;
        await move(file, path);
        await f.view.changed({ path, previousPath });
      });
      let requestSignal!: AbortSignal;
      // Native metadata notifications may be delivered before the write promise resolves.
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
        const raw = await process(file, update);
        await f.view.changed({ path: file.path, metadataChanged: true });
        return raw;
      });
      f.api.pickNodeForLink = vi.fn(async (options, link) => {
        expect(options).toMatchObject({ suggestedTitle: 'words', sourcePath: f.article.path });
        requestSignal = options.signal!;
        expect(requestSignal.aborted).toBe(false);
        order.push('created');
        await link(f.node);
        expect(requestSignal.aborted).toBe(false);
        order.push('linked');
        entered.resolve();
        await complete.promise;
        order.push('required completion');
        return f.node;
      });
      const creation = menu(f.view, 'Create note…');
      await entered.promise;
      expect((await f.store.read(f.article.path)).body).toBe(linkedBody);
      expect(order).toEqual(['created', 'linked']);
      expect(f.probe.dialog).toBe(true);
      expect(f.probe.surface.displayedBody).toBe(linkedBody);
      await f.view.changed({ path: f.article.path, metadataChanged: true });
      f.probe.persistPosition('words');
      await f.probe.positionWrite; // Must not wait for itself through the metadata notification.
      expect(requestSignal.aborted).toBe(false);
      expect((await f.store.read(f.article.path)).properties.reading_position).toBe('words');
      complete.resolve();
      await creation;
      expect(order).toEqual(['created', 'linked', 'required completion']);
      expect(annotate).toHaveBeenCalledOnce();
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect(f.probe.dialog).toBe(false);
      expect(f.vault.trashed).toEqual([]);
    },
    1500,
  );

  it.each(['body', 'rename', 'replacement', 'delete', 'type'] as const)(
    'aborts required completion promptly on an external source %s change after linking',
    async (kind) => {
      const f = await fixture(),
        linked = gate(),
        stopped = gate();
      let requestSignal!: AbortSignal;
      f.api.pickNodeForLink = async (options, link) => {
        requestSignal = options.signal!;
        requestSignal.addEventListener('abort', () => stopped.resolve(), { once: true });
        await link(f.node);
        linked.resolve();
        await stopped.promise;
        return null;
      };
      const creation = menu(f.view, 'Create note…');
      await linked.promise;
      expect(requestSignal.aborted).toBe(false);
      const oldPath = f.article.path;
      if (kind === 'body')
        f.vault.bytes.set(f.article, createDocument({ type: 'article' }, 'External edit'));
      if (kind === 'type')
        f.vault.bytes.set(f.article, createDocument({ type: 'note' }, linkedBody));
      if (kind === 'rename') await f.vault.move(f.article, 'Reading/Inbox/Renamed.md');
      if (kind === 'replacement') {
        const replacement = Object.setPrototypeOf({ path: oldPath }, TFile.prototype);
        f.vault.files.set(oldPath, replacement);
        f.vault.bytes.set(replacement, f.vault.bytes.get(f.article)!);
      }
      if (kind === 'delete') f.vault.files.delete(oldPath);
      await f.view.changed({
        path: f.article.path,
        previousPath: kind === 'rename' ? oldPath : undefined,
        deleted: kind === 'delete',
      });
      expect(requestSignal.aborted).toBe(true);
      await creation;
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(f.vault.trashed).toEqual([]);
    },
    1500,
  );

  it('aborts a pending creation on an external body change before the callback stage', async () => {
    const f = await fixture(),
      entered = gate(),
      stopped = gate();
    let requestSignal!: AbortSignal;
    f.api.pickNodeForLink = async (options) => {
      requestSignal = options.signal!;
      requestSignal.addEventListener('abort', () => stopped.resolve(), { once: true });
      entered.resolve();
      await stopped.promise;
      return null;
    };
    const creation = menu(f.view, 'Create note…');
    await entered.promise;
    f.vault.bytes.set(f.article, createDocument({ type: 'article' }, 'External edit'));
    await f.view.changed({ path: f.article.path });
    expect(requestSignal.aborted).toBe(true);
    await creation;
    expect((await f.store.read(f.article.path)).body).toBe('External edit');
    expect(f.vault.file(f.target.path)).toBe(f.target);
    expect(f.vault.trashed).toEqual([]);
  }, 1500);

  it.each(
    ['before', 'after'].flatMap((phase) =>
      ['open', 'navigate', 'list', 'markdown', 'close', 'unload'].map((action) => ({
        phase,
        action,
      })),
    ),
  )(
    'aborts Nodes $phase callback commit before waiting on public $action work',
    async ({ phase, action }) => {
      const f = await fixture(),
        next = await f.note('Reading/Inbox/B.md'),
        linked = gate(),
        stopped = gate();
      f.probe.readingQueue.open([f.article.path, next.path], f.article.path);
      let requestSignal!: AbortSignal;
      f.api.pickNodeForLink = async (options, link) => {
        requestSignal = options.signal!;
        requestSignal.addEventListener('abort', () => stopped.resolve(), { once: true });
        if (phase === 'after') await link(f.node);
        linked.resolve();
        await stopped.promise;
        return null;
      };
      const creation = menu(f.view, 'Create note…');
      await linked.promise;
      let transition: Promise<void> | undefined;
      if (action === 'open') transition = f.view.openArticle(next.path);
      if (action === 'navigate') transition = f.view.navigate(1);
      if (action === 'list') transition = f.view.readingList();
      if (action === 'markdown') transition = f.view.prepareMarkdown();
      if (action === 'close') transition = f.view.onClose();
      if (action === 'unload') f.view.stopForUnload();
      expect(requestSignal.aborted).toBe(true);
      await creation;
      await transition;
      expect((await f.store.read(f.article.path)).body).toBe(
        phase === 'after' ? linkedBody : '==words==',
      );
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(f.vault.trashed).toEqual([]);
    },
    1500,
  );

  it.each(
    ['before', 'after'].flatMap((phase) =>
      ['open', 'navigate', 'list'].map((action) => ({ phase, action })),
    ),
  )(
    'unblocks public $action $phase commit even if the provider ignores abort; rejects its late callback',
    async ({ phase, action }) => {
      const f = await fixture(),
        next = await f.note('Reading/Inbox/B.md'),
        entered = gate(),
        providerRelease = gate();
      f.probe.readingQueue.open([f.article.path, next.path], f.article.path);
      const annotate = vi.spyOn(f.store, 'annotate');
      let requestSignal!: AbortSignal;
      f.api.pickNodeForLink = vi.fn(async (options, link) => {
        requestSignal = options.signal!;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        await providerRelease.promise; // Deliberately ignores the signal.
        await expect(link(f.node)).rejects.toThrow('request has finished');
        return f.node;
      });
      const creation = menu(f.view, 'Create note…');
      await entered.promise;
      const transition =
        action === 'open'
          ? f.view.openArticle(next.path)
          : action === 'navigate'
            ? f.view.navigate(1)
            : f.view.readingList();
      expect(requestSignal.aborted).toBe(true);
      await creation;
      await transition; // Must finish while the provider remains suspended.
      providerRelease.resolve();
      await vi.mocked(f.api.pickNodeForLink).mock.results[0].value;
      expect(annotate).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0);
      expect((await f.store.read(f.article.path)).body).toBe(
        phase === 'after' ? linkedBody : '==words==',
      );
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(f.vault.trashed).toEqual([]);
    },
    1500,
  );

  it.each(
    ['before', 'after'].flatMap((phase) =>
      [
        ['footer', 'Next'],
        ['footer', 'Keep'],
        ['footer', 'Delete'],
        ['footer', 'List'],
        ['footer', 'Previous'],
        ['command', 'Move…'],
        ['command', 'Topics…'],
        ['command', 'Open Markdown'],
        ['link', 'internal'],
        ['link', 'new-leaf'],
        ['link', 'external'],
        ['menu', 'Open note'],
        ['menu', 'Change link…'],
        ['menu', 'Create note…'],
        ['menu', 'Remove link (keeps highlight)'],
        ['menu', 'Remove highlight'],
      ].map(([route, label]) => ({ phase, route, label })),
    ),
  )(
    'cancels via actual $route / $label UI $phase commit, without waiting for the provider',
    async ({ phase, route, label }) => {
      const f = await uiFixture(),
        entered = gate(),
        providerRelease = gate();
      const annotate = vi.spyOn(f.store, 'annotate'),
        targetBytes = await f.vault.read(f.target);
      const sourcePath = f.article.path;
      const neighbour = f.probe.readingQueue.neighbour(label === 'Previous' ? -1 : 1, () => true);
      let requestSignal!: AbortSignal,
        calls = 0;
      f.api.pickNodeForLink = vi.fn(async (options, link) => {
        if (++calls > 1) return null; // A second explicit Create node action is cancelled at its picker.
        requestSignal = options.signal!;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        await providerRelease.promise; // Ignores cancellation deliberately.
        await expect(link(f.node)).rejects.toThrow('request has finished');
        return f.node;
      });
      try {
        const creation = menu(f.view, 'Create note…');
        await entered.promise;
        const intent = f.click(route, label);
        expect(requestSignal.aborted).toBe(true); // Even before the next microtask.
        await intent;
        await creation;
        await f.probe.operations;
        // Reach the destination before releasing the uncooperative provider.
        if (['Next', 'Previous', 'Keep', 'Delete'].includes(label))
          expect(f.view.file?.path).toBe(neighbour);
        if (label === 'List') expect(f.view.file).toBeUndefined();
        if (label === 'Move…') expect(mocks.choose).toHaveBeenCalled();
        if (label === 'Topics…') expect(mocks.topics).toHaveBeenCalled();
        if (label === 'Change link…') expect(f.api.pickNodeForLink).toHaveBeenCalledTimes(2);
        if (label === 'Create note…') expect(calls).toBe(2);
        if (label === 'Keep') expect(f.article.path).toBe('Reading/Treasury/A.md');
        if (label === 'Open Markdown')
          await vi.waitFor(
            () =>
              expect(f.leaf.setViewState).toHaveBeenCalledWith({
                type: 'markdown',
                state: { file: sourcePath, mode: 'source' },
                active: true,
              }),
            { interval: 1 },
          );
        if (['internal', 'new-leaf', 'Open note'].includes(label)) {
          const path =
            label === 'Open note' && phase === 'before' ? 'Notes/Existing.md' : f.target.path;
          await vi.waitFor(
            () =>
              expect(f.opened.openFile).toHaveBeenCalledWith(f.vault.file(path), { active: true }),
            { interval: 1 },
          );
          expect(f.app.workspace.getLeaf).toHaveBeenCalledWith(label === 'new-leaf');
        }
        if (label === 'external') {
          expect(mocks.confirmWebLink).toHaveBeenCalledWith(
            f.app,
            'https://example.test/article',
            expect.any(Function),
            expect.any(Array),
          );
          expect(f.web).not.toHaveBeenCalled();
        }
        providerRelease.resolve();
        await vi.mocked(f.api.pickNodeForLink).mock.results[0].value;
        const changesPassage = ['Remove link (keeps highlight)', 'Remove highlight'].includes(
          label,
        );
        expect(annotate).toHaveBeenCalledTimes(
          (phase === 'after' ? 1 : 0) + (changesPassage ? 1 : 0),
        );
        if (label !== 'Delete')
          expect((await f.store.read(f.article.path)).body).toBe(
            label === 'Remove highlight'
              ? 'words'
              : label === 'Remove link (keeps highlight)'
                ? '==words=='
                : phase === 'after'
                  ? linkedBody
                  : originalLinkedBody,
          );
        expect(f.vault.trashed).toEqual(label === 'Delete' ? [sourcePath] : []);
        expect(f.vault.file(f.target.path)).toBe(f.target);
        expect(await f.vault.read(f.target)).toBe(targetBytes);
        expect(f.api.createNode).not.toHaveBeenCalled();
      } finally {
        providerRelease.resolve();
        f.view.stopForUnload();
      }
    },
    1500,
  );

  it.each([
    ['footer', 'Next'],
    ['link', 'internal'],
  ])(
    'drains an already-dispatched callback write before the %s / %s UI leaves, without rollback',
    async (route, label) => {
      const f = await uiFixture(),
        dispatched = gate(),
        release = gate(),
        process = f.vault.process.bind(f.vault);
      let requestSignal!: AbortSignal;
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
        const raw = await process(file, update);
        dispatched.resolve();
        await release.promise;
        return raw;
      });
      f.api.pickNodeForLink = async (options, link) => {
        requestSignal = options.signal!;
        await link(f.node);
        return f.node;
      };
      try {
        const creation = menu(f.view, 'Create note…');
        const rejected = expect(creation).rejects.toThrow(/request.*(finished|cancelled)/);
        await dispatched.promise;
        const intent = f.click(route, label);
        expect(requestSignal.aborted).toBe(true);
        await intent;
        expect(f.view.file).toBe(f.article);
        expect(f.opened.openFile).not.toHaveBeenCalled();
        release.resolve();
        await rejected;
        await f.probe.operations;
        if (route === 'footer') expect(f.view.file).not.toBe(f.article);
        else
          await vi.waitFor(
            () => expect(f.opened.openFile).toHaveBeenCalledWith(f.target, { active: true }),
            {
              interval: 1,
            },
          );
        expect((await f.store.read(f.article.path)).body).toBe(linkedBody);
        expect(f.vault.file(f.target.path)).toBe(f.target);
        expect(f.vault.trashed).toEqual([]);
      } finally {
        release.resolve();
        f.view.stopForUnload();
      }
    },
    1500,
  );

  it.each(['before', 'after'])(
    'keeps the actual fallback Open Markdown escape usable after source failure %s commit',
    async (phase) => {
      const f = await uiFixture(),
        entered = gate(),
        providerRelease = gate();
      let requestSignal!: AbortSignal;
      f.api.pickNodeForLink = vi.fn(async (options, link) => {
        requestSignal = options.signal!;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        await providerRelease.promise;
        await expect(link(f.node)).rejects.toThrow('request has finished');
        return f.node;
      });
      try {
        const creation = menu(f.view, 'Create note…');
        await entered.promise;
        const external = createDocument({ type: 'note', custom: 'keep' }, 'External source');
        f.vault.bytes.set(f.article, external);
        await f.view.changed({ path: f.article.path });
        expect(requestSignal.aborted).toBe(true);
        await creation;
        await vi.waitFor(
          () => expect(f.view.contentEl.textContent).toContain('Cannot display this article'),
          { interval: 1 },
        );
        await f.click('fallback', 'Open Markdown');
        await f.probe.operations;
        await vi.waitFor(
          () =>
            expect(f.leaf.setViewState).toHaveBeenCalledWith({
              type: 'markdown',
              state: { file: f.article.path, mode: 'source' },
              active: true,
            }),
          { interval: 1 },
        );
        providerRelease.resolve();
        await vi.mocked(f.api.pickNodeForLink).mock.results[0].value;
        expect(await f.vault.read(f.article)).toBe(external);
        expect(f.vault.file(f.target.path)).toBe(f.target);
        expect(f.vault.trashed).toEqual([]);
      } finally {
        providerRelease.resolve();
        f.view.stopForUnload();
      }
    },
  );

  it.each([
    ['footer', 'Next'],
    ['link', 'internal'],
    ['command', 'Open Markdown'],
    ['menu', 'Remove highlight'],
  ])(
    'invalidates queued Nodes creation at the actual %s / %s UI intent',
    async (route, label) => {
      const f = await uiFixture(),
        entered = gate(),
        release = gate();
      f.api.pickNodeForLink = vi.fn(async () => f.node);
      try {
        const busy = f.probe.operation(async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        const creation = menu(f.view, 'Create note…');
        await f.click(route, label);
        release.resolve();
        await busy;
        await creation;
        await f.probe.operations;
        expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
        expect(f.api.createNode).not.toHaveBeenCalled();
        expect(f.vault.file(f.target.path)).toBe(f.target);
        expect(f.vault.trashed).toEqual([]);
      } finally {
        release.resolve();
        f.view.stopForUnload();
      }
    },
    1500,
  );

  it('keeps required completion live for paging, heading jumps, invalid links, blocked keyboard shortcuts and background flush', async () => {
    const f = await uiFixture(),
      entered = gate(),
      complete = gate();
    let requestSignal!: AbortSignal;
    f.api.pickNodeForLink = async (options, link) => {
      requestSignal = options.signal!;
      await link(f.node);
      entered.resolve();
      await complete.promise;
      return f.node;
    };
    try {
      const creation = menu(f.view, 'Create note…');
      await entered.promise;
      // Palette checks and in-article paging do not cancel required completion.
      for (const id of ['move', 'topics', 'open-markdown'])
        expect(mocks.commands.get(id)?.checkCallback?.(true)).toBe(true);
      f.probe.surface.canPage.mockReturnValue(true);
      await f.click('footer', 'Next');
      await f.click('footer', 'Previous');
      const heading = document.createElement('h2');
      heading.id = 'section';
      f.probe.surface.body.append(heading);
      await f.click('link', 'heading');
      await f.click('link', 'unsafe');
      f.view.key(new KeyboardEvent('keydown', { key: 'j' }));
      expect(f.probe.surface.page.mock.calls).toEqual([[1], [-1]]);
      expect(f.probe.surface.reveal).toHaveBeenCalledWith(heading);
      expect(f.opened.openFile).not.toHaveBeenCalled();
      expect(f.view.file).toBe(f.article);
      const flushing = f.view.flush();
      await Promise.resolve();
      expect(requestSignal.aborted).toBe(false);
      complete.resolve();
      await creation;
      await flushing;
      expect(requestSignal.aborted).toBe(false);
    } finally {
      complete.resolve();
      f.view.stopForUnload();
    }
  });

  it('does not start a queued Nodes creation after a newer navigation intent', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate();
    f.api.pickNodeForLink = vi.fn(async () => f.node);
    const busy = f.probe.operation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const creation = menu(f.view, 'Create note…'),
      navigation = f.view.readingList();
    release.resolve();
    await busy;
    await creation;
    await navigation;
    expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
    expect(f.api.createNode).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe('==words==');
    expect(f.vault.trashed).toEqual([]);
  });

  it.each(['null', 'cancel', 'reject'] as const)(
    'retains both committed link and target after completion %s',
    async (kind) => {
      const f = await fixture(),
        annotate = vi.spyOn(f.store, 'annotate');
      const rejection = { reason: 'completion failed' },
        targetBytes = await f.vault.read(f.target);
      f.api.pickNodeForLink = async (_options, link) => {
        await link(f.node);
        if (kind === 'cancel') f.probe.articleLifetime.abort();
        if (kind === 'reject') throw rejection;
        return null;
      };
      const creation = menu(f.view, 'Create note…');
      if (kind === 'reject') await expect(creation).rejects.toBe(rejection);
      else await creation;
      expect((await f.store.read(f.article.path)).body).toBe(linkedBody);
      expect(annotate).toHaveBeenCalledOnce();
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect(await f.vault.read(f.target)).toBe(targetBytes);
      expect(f.vault.trashed).toEqual([]);
    },
  );

  it.each(['null', 'identity'] as const)(
    'does not link from a %s return or accept a callback after the request settles',
    async (result) => {
      const f = await fixture(),
        annotate = vi.spyOn(f.store, 'annotate');
      let late!: (node: NodeResult) => Promise<void>;
      f.api.pickNodeForLink = async (_options, link) => {
        late = link;
        return result === 'null' ? null : f.node;
      };
      await menu(f.view, 'Create note…');
      await expect(late(f.node)).rejects.toThrow('request has finished');
      expect((await f.store.read(f.article.path)).body).toBe('==words==');
      expect(annotate).not.toHaveBeenCalled();
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(f.vault.trashed).toEqual([]);
    },
  );

  it('rejects an in-flight callback at commit if Nodes settles the request before the write', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate();
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      entered.resolve();
      await release.promise;
      return process(file, update);
    });
    let pending!: Promise<void>;
    f.api.pickNodeForLink = async (_options, link) => {
      pending = link(f.node);
      void pending.catch(() => {});
      await entered.promise;
      return null;
    };
    const creation = menu(f.view, 'Create note…');
    const rejectedCreation = expect(creation).rejects.toThrow('request has finished');
    await entered.promise;
    // Reader observes the premature return but drains its dispatched write before
    // releasing the operation queue; close the callback scope before releasing I/O.
    await vi.waitFor(() => expect(f.probe.nodeCreation).toBeUndefined(), { interval: 1 });
    const rejected = expect(pending).rejects.toThrow('request has finished');
    release.resolve();
    await rejected;
    await rejectedCreation;
    expect((await f.store.read(f.article.path)).body).toBe('==words==');
    expect(f.vault.file(f.target.path)).toBe(f.target);
    expect(f.vault.trashed).toEqual([]);
  });

  it('rejects a duplicate callback without attempting a second source write', async () => {
    const f = await fixture(),
      annotate = vi.spyOn(f.store, 'annotate');
    f.api.pickNodeForLink = async (_options, link) => {
      await link(f.node);
      await link(f.node);
      return f.node;
    };
    await expect(menu(f.view, 'Create note…')).rejects.toThrow('callback already ran');
    expect(annotate).toHaveBeenCalledOnce();
    expect((await f.store.read(f.article.path)).body).toBe(linkedBody);
    expect(f.vault.file(f.target.path)).toBe(f.target);
    expect(f.vault.trashed).toEqual([]);
  });

  it.each([
    'disk-source',
    'snapshot',
    'displayed',
    'navigation',
    'cancel',
    'unload',
    'editor',
    'write',
    'source-swap',
    'source-rename',
  ] as const)(
    'rejects the callback on %s change, skips completion and preserves the target',
    async (kind) => {
      const f = await fixture(),
        completion = vi.fn(),
        targetBytes = await f.vault.read(f.target);
      const replacement = createDocument({ type: 'article' }, 'New source');
      f.api.pickNodeForLink = async (_options, link) => {
        if (kind === 'disk-source') f.vault.bytes.set(f.article, replacement);
        if (kind === 'snapshot') {
          f.vault.bytes.set(f.article, replacement);
          f.probe.snapshot = { ...f.probe.snapshot, ...readDocument(replacement) };
        }
        if (kind === 'displayed') f.probe.surface.displayedBody = 'Different displayed source';
        if (kind === 'navigation') f.probe.generation++;
        if (kind === 'cancel') f.probe.articleLifetime.abort();
        if (kind === 'unload') f.signal.abort();
        if (kind === 'editor') f.vault.dirty.add(f.article);
        if (kind === 'write') f.vault.failWrite = true;
        if (kind === 'source-swap') {
          const file = { path: f.article.path };
          f.vault.files.set(file.path, file);
          f.vault.bytes.set(file, replacement);
        }
        if (kind === 'source-rename') await f.vault.move(f.article, 'Reading/Inbox/Renamed.md');
        await link(f.node);
        completion();
        return f.node;
      };
      await expect(menu(f.view, 'Create note…')).rejects.toThrow();
      expect(completion).not.toHaveBeenCalled();
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect((await f.store.read(f.article.path)).body).toBe(
        ['disk-source', 'snapshot', 'source-swap'].includes(kind) ? 'New source' : '==words==',
      );
      expect(await f.vault.read(f.target)).toBe(targetBytes);
      expect(f.vault.trashed).toEqual([]);
      expect(f.probe.dialog).toBe(false);
    },
  );

  it('rejects an uncertain callback after an already-dispatched write finishes across cancellation, without rollback', async () => {
    const f = await fixture(),
      process = f.vault.process.bind(f.vault),
      completion = vi.fn();
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      const result = await process(file, update);
      f.probe.articleLifetime.abort();
      return result;
    });
    f.api.pickNodeForLink = async (_options, link) => {
      await link(f.node);
      completion();
      return f.node;
    };
    await expect(menu(f.view, 'Create note…')).rejects.toThrow('Check the saved Markdown');
    expect(completion).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe(linkedBody);
    expect(f.vault.file(f.target.path)).toBe(f.target);
    expect(f.vault.trashed).toEqual([]);
  });

  it('waits for position writes and preserves the position when the early callback commits', async () => {
    const f = await fixture(),
      entered = gate(),
      complete = gate();
    f.api.pickNodeForLink = async (_options, link) => {
      entered.resolve();
      await complete.promise;
      await link(f.node);
      return f.node;
    };
    const creation = menu(f.view, 'Create note…');
    await entered.promise;
    f.probe.persistPosition('words');
    await f.probe.positionWrite;
    complete.resolve();
    await creation;
    expect((await f.store.read(f.article.path)).properties.reading_position).toBe('words');
    expect((await f.store.read(f.article.path)).body).toBe(linkedBody);
  });

  it.each(['missing', 'old', 'standalone', 'legacy-id'] as const)(
    'leaves highlight actions usable without a supported picker (%s)',
    async (mode) => {
      const f = await fixture();
      if (mode === 'missing') (f.app as any).plugins = undefined;
      else if (mode === 'old') (f.api as any).version = 1;
      else if (mode === 'standalone') delete f.api.pickNodeForLink;
      else
        (f.app as any).plugins = {
          getPlugin: (id: string) => (id === 'obsidian-nodes' ? { api: f.api } : undefined),
        };
      await f.view.onOpen();
      await f.view.openArticle(f.article.path, true);
      f.probe.surface.body.innerHTML = '<mark>words</mark>';
      f.probe.surface.body
        .querySelector('mark')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect([...mocks.menus.at(-1)!.keys()]).toEqual(['---', 'Remove highlight']);
      await menu(f.view, 'Remove highlight');
      expect((await f.store.read(f.article.path)).body).toBe('words');
      expect(f.api.createNode).not.toHaveBeenCalled();
      f.view.stopForUnload();
    },
  );
});

describe('safe links and drawing', () => {
  it('decodes a single encoded href and rejects decoded schemes, authorities and malformed escapes', () => {
    expect(nativeLinkPath('/Notes/URI%20Path.md')).toBe('Notes/URI Path.md');
    expect(nativeLinkPath('Notes/100%25.md')).toBe('Notes/100%.md');
    for (const href of [
      'https://example.com',
      '%6Aavascript%3Aalert(1)',
      '/https%3Aevil',
      '//evil/path',
      '%2F%2Fevil',
      '#TOC',
      'bad%xx',
    ])
      expect(nativeLinkPath(href)).toBeUndefined();
  });

  it('opens only an existing identity and preserves subpaths; never invokes a create-capable link opener', async () => {
    const f = hostFixture(),
      target = await f.note('Notes/URI Path.md', '', 'topic');
    await openExistingNote(f.app, 'Notes/URI Path.md#Heading', 'Reading/Inbox/A.md');
    expect(f.opened.openFile).toHaveBeenCalledWith(target, {
      active: true,
      eState: { subpath: '#Heading' },
    });
    f.opened.openFile.mockClear();
    f.vault.files.delete(target.path);
    await expect(openExistingNote(f.app, target.path, '')).rejects.toThrow('no longer exists');
    expect(f.opened.openFile).not.toHaveBeenCalled();
    f.vault.files.set(target.path, target);
    vi.mocked(f.app.workspace.getLeaf).mockImplementation(() => {
      f.vault.files.set(target.path, { path: target.path });
      return f.opened as any;
    });
    await expect(openExistingNote(f.app, target.path, '')).rejects.toThrow('changed');
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });

  it('decodes an internal rendered Markdown href before opening its existing file', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md'),
      target = await f.note('Notes/URI Path.md', '', 'topic');
    await f.view.openArticle(article.path);
    f.probe.surface.body.innerHTML =
      '<a class="internal-link" href="/Notes/URI%20Path.md">note</a>';
    f.probe.clicked({ target: f.probe.surface.body.querySelector('a'), preventDefault: vi.fn() });
    await f.probe.operations;
    // openLinked's continuation runs after its awaited flush, never inside the operation queue.
    await Promise.resolve();
    expect(f.opened.openFile).toHaveBeenCalledWith(target, { active: true });
  });

  it('reveals a same-article heading without opening a vault note', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path);
    const surface = f.probe.surface;
    surface.body.innerHTML = '<h2 id="a-heading">Heading</h2><a href="#a-heading">TOC</a>';
    f.probe.clicked({ target: surface.body.querySelector('a'), preventDefault: vi.fn() });
    expect(surface.reveal).toHaveBeenCalledWith(surface.body.querySelector('h2'));
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });
});

describe('Reader web-link capture', () => {
  async function fixture(href = 'https://publisher.test/story', folders = defaultFolders) {
    const f = hostFixture(folders);
    const article = await f.note(`${folders.inbox}/Current.md`);
    await f.view.openArticle(article.path);
    f.probe.surface.body.innerHTML = `<a href="${href}">publisher</a>`;
    const event = { target: f.probe.surface.body.querySelector('a'), preventDefault: vi.fn() };
    f.probe.clicked(event);
    expect(event.preventDefault).toHaveBeenCalled();
    return {
      ...f,
      article,
      save: mocks.confirmWebLink.mock.lastCall![2] as (signal: AbortSignal) => Promise<void>,
    };
  }
  it('asks before saving and acquires in Inbox without changing the current article', async () => {
    const f = await fixture('HTTPS://publisher.test/story');
    expect(mocks.confirmWebLink).toHaveBeenCalledOnce();
    expect(f.vault.files.size).toBe(1);
    const surface = f.probe.surface;
    await f.save(new AbortController().signal);
    const captured = f.store.catalog.findUrl('https://publisher.test/story')!;
    expect(captured.path).toMatch(/^Reading\/Inbox\//);
    expect(f.host.ingestion.acquire).toHaveBeenLastCalledWith(captured.path, true);
    expect(f.view.file).toBe(f.article);
    expect(f.probe.surface).toBe(surface);
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });
  it('uses independent queue folders when retaining a duplicate from Stream', async () => {
    const folders = {
      inbox: 'Capture',
      stream: 'Disposable',
      later: 'Plans',
      treasury: 'Kept',
      feeds: 'Subscriptions',
    };
    const f = await fixture('https://publisher.test/story', folders);
    const existing = await f.store.capture({
      url: 'https://publisher.test/story',
      queue: 'Stream',
      body: 'authored ==words==',
    });
    await f.save(new AbortController().signal);
    expect(f.vault.files.size).toBe(2);
    expect(existing.path.startsWith('Capture/')).toBe(true);
    expect((await f.store.read(existing.path)).body).toContain('authored ==words==');
    expect(f.view.file).toBe(f.article);
  });
  it('keeps web links inside highlights on the annotation-menu path', async () => {
    const f = hostFixture();
    const article = await f.note(
      'Reading/Inbox/Current.md',
      '==[passage](https://publisher.test/story)==',
    );
    await f.view.openArticle(article.path);
    f.probe.surface.body.innerHTML =
      '<mark><a href="https://publisher.test/story">passage</a></mark>';
    f.probe.clicked({ target: f.probe.surface.body.querySelector('a'), preventDefault: vi.fn() });
    expect(mocks.confirmWebLink).not.toHaveBeenCalled();
    expect(mocks.menus).toHaveLength(1);
  });
  it.each(['modal', 'navigation', 'unload', 'source edit', 'source delete'] as const)(
    'rejects a stale %s confirmation',
    async (kind) => {
      const f = await fixture(),
        modal = new AbortController();
      if (kind === 'modal') modal.abort();
      if (kind === 'navigation') await f.view.readingList();
      if (kind === 'unload') f.signal.abort();
      if (kind === 'source edit') {
        f.vault.bytes.set(f.article, createDocument({ type: 'article' }, 'New source body'));
        await f.view.changed({ path: f.article.path });
      }
      if (kind === 'source delete') f.vault.files.delete(f.article.path);
      const count = f.vault.files.size;
      await expect(f.save(modal.signal)).rejects.toThrow('cancelled');
      expect(f.vault.files.size).toBe(count);
    },
  );
  it('does not move a duplicate when navigation cancels a pending move', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate();
    const existing = await f.store.capture({
      url: 'https://publisher.test/story',
      queue: 'Stream',
      body: 'Keep authored text',
    });
    const path = existing.path,
      raw = await f.vault.read(existing);
    f.vault.beforeMove = async () => {
      entered.resolve();
      await release.promise;
    };
    const save = f.save(new AbortController().signal).catch((error) => error);
    await entered.promise;
    await f.view.readingList();
    release.resolve();
    expect(await save).toMatchObject({ message: 'Reader capture was cancelled.' });
    expect(existing.path).toBe(path);
    expect(await f.vault.read(existing)).toBe(raw);
  });
});

describe('modal capture cancellation', () => {
  it('rechecks the modal signal at the queued create boundary', async () => {
    const f = await pluginFixture(),
      original = await f.note('Reading/Inbox/Current.md');
    await f.view.openArticle(original.path);
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    const entered = gate(),
      release = gate(),
      create = f.vault.create.bind(f.vault);
    vi.spyOn(f.vault, 'create').mockImplementationOnce(async (path, content) => {
      entered.resolve();
      await release.promise;
      return create(path, content);
    });
    const prior = f.store.capture({ url: 'https://example.com/prior' });
    await entered.promise;
    f.plugin.capture();
    const signal = new AbortController();
    const capture = mocks.input.mock.calls.at(-1)![3](
      'https://example.com/cancelled',
      signal.signal,
    );
    const rejected = expect(capture).rejects.toThrow('cancelled');
    signal.abort();
    release.resolve();
    await prior;
    await rejected;
    expect(f.store.catalog.findUrl('https://example.com/cancelled')).toBeUndefined();
    expect(f.view.file).toBe(original);
    expect(f.app.workspace.revealLeaf).not.toHaveBeenCalled();
    expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
  });

  it('retains a create already committed but does not navigate/acquire after cancellation', async () => {
    const f = await pluginFixture(),
      original = await f.note('Reading/Inbox/Current.md');
    await f.view.openArticle(original.path);
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    const signal = new AbortController(),
      create = f.vault.create.bind(f.vault);
    vi.spyOn(f.vault, 'create').mockImplementationOnce(async (path, content) => {
      const file = await create(path, content);
      signal.abort();
      return file;
    });
    f.plugin.capture();
    await mocks.input.mock.calls.at(-1)![3]('https://example.com/committed', signal.signal);
    expect(f.store.catalog.findUrl('https://example.com/committed')).toBeDefined();
    expect(f.view.file).toBe(original);
    expect(f.app.workspace.revealLeaf).not.toHaveBeenCalled();
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
  });

  it('keeps the old article mounted when cancellation overtakes the target read', async () => {
    const f = await pluginFixture(),
      original = await f.note('Reading/Inbox/Current.md');
    await f.view.openArticle(original.path);
    const target = await f.store.capture({ url: 'https://example.com/target' });
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    const entered = gate(),
      release = gate(),
      read = f.store.read.bind(f.store);
    vi.spyOn(f.store, 'read').mockImplementation(async (path) => {
      if (path === target.path) {
        entered.resolve();
        await release.promise;
      }
      return read(path);
    });
    f.plugin.capture();
    const signal = new AbortController(),
      capture = mocks.input.mock.calls.at(-1)![3]('https://example.com/target', signal.signal);
    await entered.promise;
    const surface = f.probe.surface;
    expect(f.view.file).toBe(original);
    signal.abort();
    release.resolve();
    await capture;
    expect(f.view.file).toBe(original);
    expect(f.probe.surface).toBe(surface);
    expect(f.app.workspace.revealLeaf).not.toHaveBeenCalled();
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
  });

  it('creates a new tab without focus and detaches only its empty Reader on cancellation', async () => {
    const f = await pluginFixture(),
      entered = gate(),
      release = gate();
    const leaf: any = {
      app: f.app,
      detach: vi.fn(),
      setViewState: vi.fn(async () => {
        entered.resolve();
        await release.promise;
      }),
    };
    leaf.view = new ReaderView(leaf, f.plugin);
    vi.mocked(f.app.workspace.getLeaf).mockReturnValue(leaf);
    f.plugin.capture();
    const signal = new AbortController(),
      capture = mocks.input.mock.calls.at(-1)![3]('https://example.com/target', signal.signal);
    await entered.promise;
    signal.abort();
    release.resolve();
    await capture;
    expect(leaf.setViewState).toHaveBeenCalledWith({
      type: 'obsidian-reader',
      state: {},
      active: false,
    });
    expect(leaf.detach).toHaveBeenCalledOnce();
    expect(f.app.workspace.revealLeaf).not.toHaveBeenCalled();
    expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
  });

  it('supports older submit callers that omit the modal signal', async () => {
    const f = await pluginFixture();
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    f.plugin.capture();
    await mocks.input.mock.calls.at(-1)![3]('https://example.com/saved');
    expect(f.view.file?.path).toBe(f.store.catalog.findUrl('https://example.com/saved')?.path);
    expect(f.app.workspace.revealLeaf).toHaveBeenCalledWith(f.leaf);
  });
});

describe('native Markdown escape hatch', () => {
  it.each(['malformed', 'render', 'type-change'] as const)(
    'keeps an editor escape for %s failures without saving stale state',
    async (kind) => {
      const f = await pluginFixture(),
        article = await f.note('Reading/Inbox/A.md');
      const view = new ReaderView(f.leaf, f.plugin);
      f.leaf.view = view;
      if (kind === 'malformed')
        f.vault.bytes.set(article, '---\ntype: [\n---\nvaluable authored text');
      if (kind === 'render') mocks.renderError = new Error('Content is too large.');
      await view.openArticle(article.path);
      if (kind === 'type-change') {
        f.vault.bytes.set(article, createDocument({ type: 'ordinary' }, 'user text'));
        await view.changed({ path: article.path, metadataChanged: true });
      }
      const before = await f.vault.read(article),
        position = vi.spyOn(f.store, 'position'),
        annotate = vi.spyOn(f.store, 'annotate');
      expect(view.file).toBe(article);
      expect((view as any).snapshot).toBeUndefined();
      expect(view.contentEl.textContent).toContain('Open Markdown');
      await f.plugin.edit(view, article);
      expect(f.leaf.setViewState).toHaveBeenLastCalledWith({
        type: 'markdown',
        state: { file: article.path, mode: 'source' },
        active: true,
      });
      expect(position).not.toHaveBeenCalled();
      expect(annotate).not.toHaveBeenCalled();
      expect(await f.vault.read(article)).toBe(before);
    },
  );

  it('also escapes a type change before its cache notification reaches Reader', async () => {
    const f = await pluginFixture(),
      article = await f.note('Reading/Inbox/A.md');
    const view = new ReaderView(f.leaf, f.plugin);
    f.leaf.view = view;
    await view.openArticle(article.path);
    (view as any).surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    const changed = createDocument({ type: 'ordinary' }, 'native authored text');
    f.vault.bytes.set(article, changed);
    await f.plugin.edit(view, article);
    expect(f.leaf.setViewState).toHaveBeenLastCalledWith({
      type: 'markdown',
      state: { file: article.path, mode: 'source' },
      active: true,
    });
    expect(await f.vault.read(article)).toBe(changed);
  });
});

describe('plugin routing and conservative expiry', () => {
  it('fails closed while any per-file cache is missing, even if resolved fires', async () => {
    const f = await pluginFixture(),
      file = await f.note('Reading/Stream/000101 Old.md');
    const cached = f.cache.get(file);
    f.cache.delete(file);
    const expire = vi
      .spyOn(f.store, 'expire')
      .mockResolvedValue({ deleted: 0, retained: 0, promoted: 0 });
    f.layouts.forEach((run) => run());
    await f.pluginProbe.tick(true);
    expect(expire).not.toHaveBeenCalled();
    f.metadata('resolved');
    expect(expire).not.toHaveBeenCalled();
    expect(f.pluginProbe.referencesReady).toBe(false);
    f.cache.set(file, cached);
    f.metadata('resolved');
    expect(expire).toHaveBeenCalledOnce();
    f.metadata('changed', file);
    await f.pluginProbe.expire();
    expect(expire).toHaveBeenCalledOnce();
    f.metadata('resolved');
    await f.pluginProbe.expire();
    expect(expire).toHaveBeenCalledTimes(2);
  });

  it('enables late-plugin-load expiry from complete public link metadata without resolvedLinks or body scans', async () => {
    const f = hostFixture(),
      source = await f.note('Notes/Source.md', '', 'topic');
    const bodyTarget = await f.note('Reading/Stream/000101 Body target.md'),
      frontmatterTarget = await f.note('Reading/Stream/000101 Frontmatter target.md');
    f.cache.get(source).links = [
      { link: encodeURI(bodyTarget.path), original: `[keep](/${encodeURI(bodyTarget.path)})` },
    ];
    f.cache.get(source).frontmatterLinks = [
      { link: frontmatterTarget.path, original: `[[${frontmatterTarget.path}]]`, key: 'related' },
    ];
    // The original completion event happened before plugin registration, and the
    // aggregate index is deliberately unavailable. Per-file metadata is sufficient.
    f.metadata('resolved');
    Object.defineProperty(f.app.metadataCache, 'resolvedLinks', {
      get() {
        throw new Error('Do not consult aggregate link state');
      },
    });
    const reads = vi.spyOn(f.vault, 'read'),
      enumerate = vi.spyOn(f.app.vault, 'getMarkdownFiles');
    const plugin = new ReaderPlugin(f.app, {} as any);
    (plugin as any).app = f.app;
    await plugin.onload();
    plugin.store = f.store;
    const probe = plugin as any;
    vi.spyOn(probe, 'promote').mockResolvedValue(undefined);
    const expire = vi
      .spyOn(f.store, 'expire')
      .mockResolvedValue({ deleted: 0, retained: 2, promoted: 0 });
    f.layouts.forEach((run) => run());
    await probe.tick(true);
    expect(probe.referencesReady).toBe(true);
    expect(probe.referencesRecovered).toBe(true);
    expect(probe.promotions.has(bodyTarget)).toBe(true);
    expect(probe.promotions.has(frontmatterTarget)).toBe(true);
    expect(expire).toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(enumerate).toHaveBeenCalledOnce();
    const guard = expire.mock.calls[0][1]!;
    expect(guard(bodyTarget)).toBe(true);
    expect(guard(frontmatterTarget)).toBe(true);
    // Future completion events need no second vault-wide reconstruction.
    f.metadata('resolved');
    expect(enumerate).toHaveBeenCalledOnce();
  });

  it('queues startup YAML-link/topic promotion from metadata only, then revalidates only those articles', async () => {
    const f = await pluginFixture();
    const candidates: TFile[] = [],
      ordinary: TFile[] = [];
    for (const [index, properties] of [
      { related: '[[Topics/X.md]]' },
      { related: { nested: [{ title: '[[Topics/X.md]]' }] } },
      { topics: ['Research'] },
      { feed: '[[Reading/Wires/Feed.md]]', reading_position: 'quote:[[Topics/X.md]]' },
      {},
    ].entries()) {
      const file = await f.note(`Reading/Stream/261013 Article ${index}.md`);
      const raw = await f.vault.process(file, (current) => patchProperties(current, properties));
      f.cache.get(file).frontmatter = readDocument(raw).properties;
      (index < 3 ? candidates : ordinary).push(file);
    }
    const reads = vi.spyOn(f.vault, 'read'),
      promote = vi.spyOn(f.pluginProbe, 'promote').mockResolvedValue(undefined);
    expect(f.pluginProbe.recoverReferences()).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    for (const file of candidates) expect(f.pluginProbe.promotions.has(file)).toBe(true);
    for (const file of ordinary) expect(f.pluginProbe.promotions.has(file)).toBe(false);
    f.pluginProbe.referencesReady = true;
    const expire = vi
      .spyOn(f.store, 'expire')
      .mockResolvedValue({ deleted: 0, retained: 3, promoted: 0 });
    await f.pluginProbe.expire();
    const guard = expire.mock.calls[0][1]!;
    for (const file of candidates) expect(guard(file)).toBe(true);
    for (const file of ordinary) expect(guard(file)).toBe(false);
    promote.mockRestore();
    for (const file of candidates) await f.pluginProbe.promote(file);
    for (const file of candidates) expect(file.path).toContain('/Inbox/');
    for (const file of ordinary) expect(file.path).toContain('/Stream/');
    expect(reads.mock.calls.every(([file]) => candidates.includes(file as TFile))).toBe(true);
    expect(f.vault.trashed).toEqual([]);
  });

  it.each([
    { type: 'article', retain: false },
    { type: 'feed', retain: false },
    { type: 'topic', retain: true },
    { type: undefined, retain: true },
  ])(
    'filters source/state cached links only on identified Reader records: %j',
    async ({ type, retain }) => {
      const f = await pluginFixture(),
        source = await f.note('Notes/Source.md', '', 'topic');
      const properties: Record<string, unknown> = { type },
        links: any[] = [],
        targets: TFile[] = [];
      for (const key of [
        'feed',
        'reading_position',
        'title',
        'error',
        'url',
        'published',
        ...(type === 'article' ? [] : ['prefix', 'enabled']),
      ]) {
        const target = await f.note(`Reading/Stream/000101 ${key}.md`);
        targets.push(target);
        properties[key] = `literal [[${target.path}]]`;
        links.push({ key, link: target.path, original: `[[${target.path}]]` });
      }
      const raw = await f.vault.process(source, (current) => patchProperties(current, properties));
      f.cache.set(source, { frontmatter: readDocument(raw).properties, frontmatterLinks: links });
      const reads = vi.spyOn(f.vault, 'read');
      vi.spyOn(f.pluginProbe, 'promote').mockResolvedValue(undefined);
      expect(f.pluginProbe.recoverReferences()).toBe(true);
      for (const target of targets) expect(f.pluginProbe.promotions.has(target)).toBe(retain);
      expect(f.app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledTimes(
        retain ? targets.length : 0,
      );
      expect(reads).not.toHaveBeenCalled();
      // Unknown nested fields remain real outgoing references even on Reader records.
      f.cache.get(source).frontmatter.related = { target: `[[${targets[0].path}]]` };
      f.cache.get(source).frontmatterLinks = [
        { key: 'related.target', link: targets[0].path, original: `[[${targets[0].path}]]` },
      ];
      f.pluginProbe.keepReferences(source);
      expect(f.pluginProbe.promotions.get(targets[0])).toBe(true);
    },
  );

  it.each([false, true])(
    'revalidates a live unknown-field annotation against current bytes (stale cache: %s)',
    async (stale) => {
      const f = await pluginFixture(),
        file = await f.note('Reading/Stream/Article.md');
      const properties = { type: 'article', related: { nested: ['[[Topics/X.md]]'] } };
      f.cache.get(file).frontmatter = properties;
      if (!stale) await f.vault.process(file, (raw) => patchProperties(raw, properties));
      const before = await f.vault.read(file),
        promote = vi.spyOn(f.pluginProbe, 'promote');
      f.pluginProbe.changed({ path: file.path, metadataChanged: false });
      await Promise.all(promote.mock.results.map((result) => result.value));
      expect(file.path).toBe(`Reading/${stale ? 'Stream' : 'Inbox'}/Article.md`);
      expect(await f.vault.read(file)).toBe(before);
      expect(f.vault.trashed).toEqual([]);
    },
  );

  it('blocks expiry again if a public cache disappears after startup recovery', async () => {
    const f = await pluginFixture(),
      file = await f.note('Reading/Stream/000101 Article.md');
    expect(f.pluginProbe.recoverReferences()).toBe(true);
    f.pluginProbe.referencesReady = true;
    const cache = f.cache.get(file);
    f.cache.delete(file);
    const expire = vi
      .spyOn(f.store, 'expire')
      .mockResolvedValue({ deleted: 0, retained: 0, promoted: 0 });
    f.metadata('resolve', file);
    f.metadata('resolved');
    await f.pluginProbe.expire();
    expect(f.pluginProbe.referencesReady).toBe(false);
    expect(expire).not.toHaveBeenCalled();
    f.cache.set(file, cache);
    f.metadata('resolved');
    expect(f.pluginProbe.referencesReady).toBe(true);
    expect(expire).toHaveBeenCalledOnce();
  });

  it('never treats publisher fragments, authorities or schemes as native-link promotion', async () => {
    const f = await pluginFixture(),
      source = await f.note('Notes/Source.md', '', 'topic'),
      target = await f.note('Reading/Stream/000101 Old.md');
    vi.spyOn(f.pluginProbe, 'promote').mockResolvedValue(undefined);
    f.cache.get(source).links = [
      '#toc',
      '//publisher/path',
      'https://publisher/path',
      '%6aavascript%3Aalert(1)',
      '%23toc',
      target.path,
    ].map((link) => ({ link }));
    f.pluginProbe.changed({ path: source.path });
    expect(f.app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledTimes(1);
    expect(f.pluginProbe.promotions.has(target)).toBe(true);
    // Startup reconstruction uses the same provenance-aware filter.
    vi.mocked(f.app.metadataCache.getFirstLinkpathDest).mockClear();
    f.pluginProbe.recoverReferences();
    expect(f.app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledTimes(1);
  });

  it('protects all open FileViews and Reader articles even without a saveable selection', async () => {
    const f = await pluginFixture(),
      native = await f.note('Reading/Stream/000101 Native.md'),
      reader = await f.note('Reading/Stream/000101 Reader.md');
    await f.view.openArticle(reader.path);
    const preview = new MarkdownView(f.leaf);
    (preview as any).file = native;
    f.leaves.push({ view: preview });
    const other = await f.note('Reading/Stream/000101 Other.md'),
      otherView = new (FileView as unknown as new () => FileView)();
    (otherView as any).file = other;
    f.leaves.push({ view: otherView });
    f.pluginProbe.referencesReady = true;
    await f.pluginProbe.expire();
    expect(f.vault.trashed).toEqual([]);
  });

  it('expires the Markdown exemption when that leaf navigates away, including to an ordinary note', async () => {
    const f = await pluginFixture(),
      article = await f.note('Reading/Inbox/A.md'),
      ordinary = await f.note('Notes/Ordinary.md', '', 'topic');
    // Use the plugin as the real view host for this transition.
    (article as any).stat = { mtime: 1, size: f.vault.bytes.get(article)!.length };
    vi.mocked(f.app.workspace.getActiveViewOfType).mockImplementation((constructor: any) =>
      f.leaf.view instanceof constructor ? f.leaf.view : null,
    );
    const view = new ReaderView(f.leaf, f.plugin);
    f.leaf.view = view;
    await view.openArticle(article.path);
    await f.pluginProbe.presentations.get(f.leaf);
    f.leaf.setViewState.mockClear(); // The initial title refresh is not a Markdown escape.
    f.leaf.setViewState.mockImplementation(async (state: any) => {
      if (state.type === 'markdown') {
        const native = new MarkdownView(f.leaf);
        Object.assign(native, {
          file: article,
          editor: { getValue: () => f.vault.bytes.get(native.file!) },
        });
        f.leaf.view = native;
        f.workspace('file-open', article);
      }
    });
    await f.plugin.edit(view, article);
    expect(f.leaf.setViewState).toHaveBeenCalledTimes(1);
    f.leaf.view.file = ordinary;
    f.workspace('file-open', ordinary);
    f.leaf.view.file = article;
    f.workspace('file-open', article);
    await vi.waitFor(
      () =>
        expect(f.leaf.setViewState).toHaveBeenLastCalledWith({
          type: 'obsidian-reader',
          state: { file: article.path },
        }),
      { interval: 1 },
    );
  });

  it('flushes proactively when hidden, but unload synchronously closes the write barrier', async () => {
    const f = await pluginFixture(),
      article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path);
    const flush = vi.spyOn(f.view, 'flush').mockResolvedValue();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    mocks.dom.get('visibilitychange')!();
    expect(flush).toHaveBeenCalledOnce();
    expect(f.plugin.onunload()).toBeUndefined();
    expect(f.plugin.signal.aborted).toBe(true);
    await expect(f.store.position(article.path, 'words')).rejects.toThrow('stopped');
  });
});
