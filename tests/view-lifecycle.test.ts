// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileView, MarkdownView, TFile, type App, type WorkspaceLeaf } from 'obsidian';
import { ArticleStore, type VaultPort } from '../src/core/store';
import { createDocument, patchProperties, readDocument } from '../src/core/document';
import { passages } from '../src/core/annotations';
import { ReaderView, nativeLinkPath, openExistingNote } from '../src/reader/view';
import ReaderPlugin from '../src/main';
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
  pickNode: vi.fn(),
  notice: vi.fn(),
  input: vi.fn(),
  confirmWebLink: vi.fn(),
  menus: [] as Map<string, () => void>[],
  dom: new Map<string, () => void>(),
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
    addCommand() {}
    addSettingTab() {}
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
vi.mock('../src/host/node-picker', () => ({ pickNode: mocks.pickNode }));
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
    finish = document.createElement('div');
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
      parent.append(this.body, this.finish);
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
  mocks.renderError = undefined;
  mocks.choose.mockResolvedValue(null);
  mocks.topics.mockResolvedValue(null);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function hostFixture() {
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
  const store = new ArticleStore(vault as unknown as VaultPort<TFile>);
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

describe('highlight save feedback and native title refresh', () => {
  it.each(['success', 'failure', 'stopping', 'stale', 'surface replaced'] as const)(
    'acknowledges only a confirmed current save: %s',
    async (outcome) => {
      const f = hostFixture(),
        file = await f.note('Reading/Inbox/A.md');
      await f.view.openArticle(file.path);
      const surface = f.probe.surface;
      surface.selectionValue = {
        quote: 'words',
        before: 'before ',
        after: ' after',
        range: document.createRange(),
      };
      const acknowledge = vi.fn();
      surface.highlightFeedback.mockReturnValue(acknowledge);
      const entered = gate(),
        release = gate();
      const annotate = f.store.annotate.bind(f.store);
      vi.spyOn(f.store, 'annotate').mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        if (outcome === 'failure') throw new Error('Save failed');
        return annotate(...args);
      });
      const saving = f.probe.saveSelection();
      await entered.promise;
      expect(acknowledge).not.toHaveBeenCalled();
      if (outcome === 'stopping') f.probe.stopping = true;
      if (outcome === 'surface replaced') f.probe.surface = undefined;
      if (outcome === 'stale') f.probe.generation++;
      release.resolve();
      if (['failure', 'stale', 'surface replaced'].includes(outcome))
        await expect(saving).rejects.toThrow();
      else await saving;
      expect(acknowledge).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
      if (outcome === 'success') {
        expect(surface.displayedBody).toBe('before words after');
        expect(surface.selectionValue.quote).toBe('words');
        await f.probe.saveSelection(); // identical selection is a no-op
        expect(acknowledge).toHaveBeenCalledTimes(1);
      }
    },
  );
  it('refreshes cloned native state without recursively opening or remounting the article', async () => {
    const f = hostFixture(),
      file = await f.note('Reading/Inbox/A.md');
    f.leaf.setViewState.mockImplementation(async ({ state }: any) =>
      f.view.setState(JSON.parse(JSON.stringify(state)), { history: false }),
    );
    await f.view.openArticle(file.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    const selection = surface.selectionValue;
    expect(f.view.getDisplayText()).toBe('Reader: A');
    const raw = await f.vault.read(file);
    f.vault.bytes.set(file, patchProperties(raw, { title: 'External title' }));
    await f.view.changed({ path: file.path });
    expect(f.view.getDisplayText()).toBe('Reader: External title');
    expect(f.view.contentEl.querySelector('h1')?.textContent).toBe('External title');
    expect(f.probe.surface).toBe(surface);
    expect(surface.dispose).not.toHaveBeenCalled();
    expect(surface.selectionValue).toBe(selection);
    expect(f.view.getState()).not.toHaveProperty('readerPresentationOnly');
    surface.selectionValue = undefined;
    await f.view.readingList();
    expect(f.view.getDisplayText()).toBe('Reading list');
    expect(f.leaf.setViewState).toHaveBeenCalledTimes(3);
  });
  it('does not swallow concurrent navigation or replay an old article after delayed cloned refreshes', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md');
    const pending: { state: Record<string, unknown>; done: ReturnType<typeof gate> }[] = [];
    f.leaf.setViewState.mockImplementation(({ state }: any) => {
      const done = gate();
      pending.push({ state: JSON.parse(JSON.stringify(state)), done });
      return done.promise;
    });
    await f.view.openArticle(a.path);
    const first = f.probe.surface;
    // An ordinary state request must navigate even with a presentation refresh pending.
    await f.view.setState({ file: b.path, queue: 'Inbox' }, { history: false });
    const current = f.probe.surface;
    expect(f.view.file).toBe(b);
    expect(current).not.toBe(first);
    current.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    const selection = current.selectionValue;
    expect(pending).toHaveLength(2);
    for (const request of pending.reverse()) {
      const result = { history: true };
      await f.view.setState(request.state, result);
      request.done.resolve();
      expect(result.history).toBe(false);
      expect(f.view.file).toBe(b);
      expect(f.probe.surface).toBe(current);
      expect(current.selectionValue).toBe(selection);
    }
    expect(current.dispose).not.toHaveBeenCalled();
    expect(f.view.getDisplayText()).toBe('Reader: B');
    expect(f.view.getState()).toEqual({ file: b.path, queue: 'Inbox' });
    current.selectionValue = undefined;
    await f.view.readingList();
    const last = pending[pending.length - 1];
    await f.view.setState(last.state, { history: false });
    last.done.resolve();
    expect(f.view.getDisplayText()).toBe('Reading list');
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

describe('browsing context and presentation', () => {
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
    expect(f.view.getDisplayText()).toBe('Reader: Renamed');
    expect(f.view.getState().file).toBe(b.path);
    await f.view.readingList();
    expect(f.view.getState().file).toBeUndefined();
    expect(f.view.getDisplayText()).toBe('Reading list');
    expect(f.app.workspace.requestSaveLayout).toHaveBeenCalledTimes(4);
  });

  it.each([
    'before ==words== after',
    'before [[Notes/Target]] after',
    'before [words](/Notes/Target.md) after',
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
  it('allows a position save while a link picker is open without losing the annotation', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', '==words=='),
      target = await f.note('Notes/Target.md', '', 'topic');
    await f.view.openArticle(article.path);
    const started = gate(),
      finish = gate();
    mocks.choose.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      return target;
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
    mocks.choose.mockResolvedValue(target);
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
      };
      let current: unknown = api;
      (f.app as any).plugins = { getPlugin: () => ({ api: current }) };
      await f.view.openArticle(article.path);
      mocks.pickNode.mockResolvedValue({ ...node });
      const original = f.vault.process.bind(f.vault);
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
        if (kind === 'api') current = { ...api };
        else if (kind === 'classes') node.classes = ['person'];
        else if (kind === 'file') f.vault.files.delete(target.path);
        else f.vault.files.set(target.path, { path: target.path });
        return original(file, transform);
      });
      await expect(menu(f.view, 'Link to node…')).rejects.toThrow(/selected (node|note)/);
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
    mocks.choose.mockResolvedValue(target);
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
    await menu(f.view, 'Unlink (keep highlight)');
    expect((await f.store.read(article.path)).body).toBe('==**formatted words**==');
  });
});

describe('Nodes v2 linked creation', () => {
  async function fixture() {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', '==words=='),
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
    };
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    await f.view.openArticle(article.path);
    return { ...f, article, target, node, api };
  }
  const linkedBody = '==[[Nodes/One.md|words]]==';

  it.each([
    ['topic', 'Other'],
    ['Other', 'topic'],
    ['Other', 'topic', 'Extra'],
  ])(
    'links an existing node by class membership, not primary type or class order (%j)',
    async (...classes) => {
      const f = await fixture();
      f.api.getNode = () => ({ ...f.node, type: 'Other', classes });
      mocks.pickNode.mockResolvedValue(f.node);
      await menu(f.view, 'Link to node…');
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
      f.api.createNodeForLink = vi.fn(async (options, link) => {
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
      const creation = menu(f.view, 'Create node…');
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
      f.api.createNodeForLink = async (options, link) => {
        requestSignal = options.signal!;
        requestSignal.addEventListener('abort', () => stopped.resolve(), { once: true });
        await link(f.node);
        linked.resolve();
        await stopped.promise;
        return null;
      };
      const creation = menu(f.view, 'Create node…');
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
    f.api.createNodeForLink = async (options) => {
      requestSignal = options.signal!;
      requestSignal.addEventListener('abort', () => stopped.resolve(), { once: true });
      entered.resolve();
      await stopped.promise;
      return null;
    };
    const creation = menu(f.view, 'Create node…');
    await entered.promise;
    f.vault.bytes.set(f.article, createDocument({ type: 'article' }, 'External edit'));
    await f.view.changed({ path: f.article.path });
    expect(requestSignal.aborted).toBe(true);
    await creation;
    expect((await f.store.read(f.article.path)).body).toBe('External edit');
    expect(f.vault.file(f.target.path)).toBe(f.target);
    expect(f.vault.trashed).toEqual([]);
  }, 1500);

  it.each(['open', 'navigate', 'list', 'markdown', 'close', 'unload'] as const)(
    'aborts required completion before waiting on queued %s work',
    async (action) => {
      const f = await fixture(),
        next = await f.note('Reading/Inbox/B.md'),
        linked = gate(),
        stopped = gate();
      f.probe.readingQueue.open([f.article.path, next.path], f.article.path);
      let requestSignal!: AbortSignal;
      f.api.createNodeForLink = async (options, link) => {
        requestSignal = options.signal!;
        requestSignal.addEventListener('abort', () => stopped.resolve(), { once: true });
        await link(f.node);
        linked.resolve();
        await stopped.promise;
        return null;
      };
      const creation = menu(f.view, 'Create node…');
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
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(f.vault.trashed).toEqual([]);
    },
    1500,
  );

  it.each(['null', 'cancel', 'reject'] as const)(
    'retains both committed link and target after completion %s',
    async (kind) => {
      const f = await fixture(),
        annotate = vi.spyOn(f.store, 'annotate');
      const rejection = { reason: 'completion failed' },
        targetBytes = await f.vault.read(f.target);
      f.api.createNodeForLink = async (_options, link) => {
        await link(f.node);
        if (kind === 'cancel') f.probe.articleLifetime.abort();
        if (kind === 'reject') throw rejection;
        return null;
      };
      const creation = menu(f.view, 'Create node…');
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
      f.api.createNodeForLink = async (_options, link) => {
        late = link;
        return result === 'null' ? null : f.node;
      };
      await menu(f.view, 'Create node…');
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
    f.api.createNodeForLink = async (_options, link) => {
      pending = link(f.node);
      void pending.catch(() => {});
      await entered.promise;
      return null;
    };
    await menu(f.view, 'Create node…');
    const rejected = expect(pending).rejects.toThrow('request has finished');
    release.resolve();
    await rejected;
    expect((await f.store.read(f.article.path)).body).toBe('==words==');
    expect(f.vault.file(f.target.path)).toBe(f.target);
    expect(f.vault.trashed).toEqual([]);
  });

  it('rejects a duplicate callback without attempting a second source write', async () => {
    const f = await fixture(),
      annotate = vi.spyOn(f.store, 'annotate');
    f.api.createNodeForLink = async (_options, link) => {
      await link(f.node);
      await link(f.node);
      return f.node;
    };
    await expect(menu(f.view, 'Create node…')).rejects.toThrow('callback already ran');
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
      f.api.createNodeForLink = async (_options, link) => {
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
      await expect(menu(f.view, 'Create node…')).rejects.toThrow();
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
    f.api.createNodeForLink = async (_options, link) => {
      await link(f.node);
      completion();
      return f.node;
    };
    await expect(menu(f.view, 'Create node…')).rejects.toThrow('Check the saved Markdown');
    expect(completion).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe(linkedBody);
    expect(f.vault.file(f.target.path)).toBe(f.target);
    expect(f.vault.trashed).toEqual([]);
  });

  it('waits for position writes and preserves the position when the early callback commits', async () => {
    const f = await fixture(),
      entered = gate(),
      complete = gate();
    f.api.createNodeForLink = async (_options, link) => {
      entered.resolve();
      await complete.promise;
      await link(f.node);
      return f.node;
    };
    const creation = menu(f.view, 'Create node…');
    await entered.promise;
    f.probe.persistPosition('words');
    await f.probe.positionWrite;
    complete.resolve();
    await creation;
    expect((await f.store.read(f.article.path)).properties.reading_position).toBe('words');
    expect((await f.store.read(f.article.path)).body).toBe(linkedBody);
  });

  it('uses guarded standalone capture only when linked capture is absent', async () => {
    const f = await fixture(),
      entered = gate(),
      complete = gate(),
      annotate = vi.spyOn(f.store, 'annotate');
    f.api.createNode = vi.fn(async (options) => {
      expect(options?.sourcePath).toBe(f.article.path);
      entered.resolve();
      await complete.promise;
      return f.node;
    });
    const creation = menu(f.view, 'Create node…');
    await entered.promise;
    expect(annotate).not.toHaveBeenCalled();
    complete.resolve();
    await creation;
    expect(f.api.createNode).toHaveBeenCalledOnce();
    expect(annotate).toHaveBeenCalledOnce();
    expect((await f.store.read(f.article.path)).body).toBe(linkedBody);
  });

  it('does not prune a standalone partial result or link a late standalone result after cancellation', async () => {
    const f = await fixture();
    f.api.createNode = vi.fn(async () => null);
    await menu(f.view, 'Create node…');
    expect(f.vault.file(f.target.path)).toBe(f.target);
    f.api.createNode = vi.fn(async () => {
      f.probe.articleLifetime.abort();
      return f.node;
    });
    await expect(menu(f.view, 'Create node…')).rejects.toThrow('cancelled');
    expect((await f.store.read(f.article.path)).body).toBe('==words==');
    expect(f.vault.trashed).toEqual([]);
  });
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
  async function fixture(href = 'https://publisher.test/story') {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/Current.md');
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

  it('deduplicates and retains an existing Stream article in Inbox', async () => {
    const f = await fixture();
    const existing = await f.store.capture({
      url: 'https://publisher.test/story',
      queue: 'Stream',
      body: 'authored ==words==',
    });
    await f.save(new AbortController().signal);
    expect(f.vault.files.size).toBe(2);
    expect(existing.path).toMatch(/^Reading\/Inbox\//);
    expect((await f.store.read(existing.path)).body).toContain('authored ==words==');
    expect(f.view.file).toBe(f.article);
  });

  it.each(['modal', 'navigation', 'unload'])('rejects a stale %s confirmation', async (kind) => {
    const f = await fixture();
    const modal = new AbortController();
    if (kind === 'modal') modal.abort();
    if (kind === 'navigation') await f.view.readingList();
    if (kind === 'unload') f.signal.abort();
    await expect(f.save(modal.signal)).rejects.toThrow('cancelled');
    expect(f.vault.files.size).toBe(1);
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
    const view = new ReaderView(f.leaf, f.plugin);
    f.leaf.view = view;
    await view.openArticle(article.path);
    f.leaf.setViewState.mockClear(); // Ignore the presentation-only refresh on open.
    f.leaf.setViewState.mockImplementation(async (state: any) => {
      if (state.type === 'markdown') {
        const native = new MarkdownView(f.leaf);
        (native as any).file = article;
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
    expect(f.leaf.setViewState).toHaveBeenLastCalledWith({
      type: 'obsidian-reader',
      state: { file: article.path },
      active: true,
    });
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
