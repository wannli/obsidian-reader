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
import { createDocument, patchProperties, readDocument, replaceBody } from '../src/core/document';
import { changePassage, passages } from '../src/core/annotations';
import { hostPassage, hostSelection, paragraphAnchors } from '../src/core/hosted-highlights';
import {
  appendQuotation,
  originLink,
  rememberOrigin,
  removeQuotation,
} from '../src/core/quotation';
import { renderBody } from '../src/reader/render';
import { articleTopicPill, type ArticleTopic } from '../src/reader/topic-pills';
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
  highlightPicker: vi.fn(),
  menus: [] as Map<string, () => void>[],
  menuShown: vi.fn(),
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
    showAtMouseEvent(event: MouseEvent) {
      mocks.menuShown(event);
    }
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
vi.mock('../src/host/highlight-picker', () => ({ chooseHighlightHost: mocks.highlightPicker }));
const defaultHighlightPath = 'Nodes/Default.md';
vi.mock('../src/host/topic-filter-dialog', () => ({ chooseTopicFilter: vi.fn() }));
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
    viewport = document.createElement('div');
    flow = document.createElement('div');
    body = document.createElement('article');
    title = document.createElement('h1');
    topics = document.createElement('div');
    setTopics = vi.fn((topics: readonly ArticleTopic[]) => {
      const pill = articleTopicPill(document, topics, this.referenceIcon);
      this.topics.replaceChildren(...(pill ? [pill] : []));
      if (pill) this.body.before(this.topics);
      else this.topics.remove();
    });
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
      readonly paged: boolean,
      private position: (marker: string) => void,
      private renderError?: (error: unknown) => void,
      private referenceIcon?: (target: string, element: HTMLElement) => void,
    ) {
      this.topics.className = 'reader-article-topics';
      this.viewport.className = 'reader-viewport';
      this.flow.className = 'reader-flow';
      this.flow.append(this.title, this.body);
      this.viewport.append(this.flow);
      parent.append(this.viewport);
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
const fixtureViews = new Set<ReaderView>();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.menus.length = 0;
  mocks.dom.clear();
  mocks.commands.clear();
  mocks.protocols.clear();
  mocks.renderError = undefined;
  Platform.isMobile = false;
  mocks.choose.mockReset().mockResolvedValue(null);
  mocks.highlightPicker.mockReset().mockResolvedValue(null);
  mocks.topics.mockResolvedValue(null);
});
afterEach(() => {
  // Detached fixture leaves must not retain document-level Escape handlers.
  for (const view of fixtureViews) view.stopForUnload();
  fixtureViews.clear();
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
  fixtureViews.add(view);
  leaf.view = view;
  async function note(path: string, body = 'before words after', type = 'article') {
    const status = /(?:^|\/)Stream\//.test(path)
      ? 'feed'
      : /(?:^|\/)Later\//.test(path)
        ? 'later'
        : /(?:^|\/)Treasury\//.test(path)
          ? 'archive'
          : 'inbox';
    const properties = type === 'article' ? { type, status } : { type };
    const file = await vault.create(path, createDocument(properties, body));
    Object.setPrototypeOf(file, TFile.prototype);
    cache.set(file, { frontmatter: properties, sections: [{ type: 'paragraph' }], links: [] });
    store.catalog.update(path, properties);
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
async function enableHighlightHost(f: ReturnType<typeof hostFixture>, ...articles: TFile[]) {
  const target =
    (f.vault.file(defaultHighlightPath) as TFile | undefined) ??
    (await f.note(defaultHighlightPath, 'Lifecycle destination.', 'topic'));
  const node: NodeResult = {
    path: target.path,
    title: 'Default',
    type: 'Other',
    classes: ['Other', 'topic'],
    aliases: [],
  };
  const api: NodesApi = {
    version: 2,
    listTypes: vi.fn(() => [{ type: 'topic', label: 'Topic' }]),
    searchNodes: vi.fn(() => [node]),
    getNode: vi.fn((path) => (path === target.path ? node : null)),
    createNode: vi.fn(async () => null),
    createNodeForLink: vi.fn(async () => null),
    pickNodeForLink: vi.fn(async () => null),
  };
  (f.app as any).plugins = {
    getPlugin: (id: string) => (id === 'fileclass-inline' ? { api } : undefined),
  };
  mocks.highlightPicker.mockImplementation(async (_app, current) =>
    current === api ? { kind: 'existing', node } : null,
  );
  for (const article of articles) await rememberDefaultHost(f, article);
  return { target, node, api };
}
function enableTypedTopics(f: ReturnType<typeof hostFixture>) {
  const nodeAt = (path: string): NodeResult | null => {
    const file = f.vault.file(path);
    return file && f.cache.get(file)?.frontmatter?.type === 'topic'
      ? {
          path,
          title: (file as TFile).basename,
          type: 'Other',
          classes: ['Other', 'topic'],
          aliases: [],
        }
      : null;
  };
  const api: NodesApi = {
    version: 2,
    listTypes: vi.fn(() => [{ type: 'topic', label: 'Topic' }]),
    searchNodes: vi.fn(() => [...f.vault.files.keys()].flatMap((path) => nodeAt(path) ?? [])),
    getNode: vi.fn(nodeAt),
    createNode: vi.fn(async () => null),
  };
  (f.app as any).plugins = {
    getPlugin: (id: string) => (id === 'fileclass-inline' ? { api } : undefined),
  };
  return api;
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
  if (
    label === 'Change article status and advance' ||
    label.startsWith('Change status and advance ·')
  )
    return 'Change status';
  return label.replace(/ (?:page or article|article(?: and advance)?)$/, '');
}
function passageButton(view: ReaderView, label: string): HTMLButtonElement {
  const button = [
    ...view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button'),
  ].find((button) => button.getAttribute('aria-label') === label);
  expect(button, `Passage bar button: ${label}`).toBeDefined();
  expect(button!.hidden).toBe(false);
  expect(button!.disabled).toBe(false);
  return button!;
}
function passageLabels(view: ReaderView): string[] {
  return [...view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button')]
    .filter((button) => !button.hidden)
    .map((button) => button.getAttribute('aria-label')!);
}
function expectNoPassagePopup() {
  expect(mocks.menus).toHaveLength(0);
  expect(mocks.menuShown).not.toHaveBeenCalled();
}
function expectedPassageActions({ linked = false, provider = true, undo = false } = {}): string[] {
  return [
    ...(linked ? ['Open note'] : []),
    ...(provider
      ? ['Add highlight to notes…', 'Convert to note link…']
      : [
          'Add highlight to notes… (requires Fileclass Inline v2)',
          'Convert to note link… (requires Fileclass Inline v2)',
        ]),
    ...(linked ? ['Remove references (article only)'] : []),
    'Remove highlight (article only)',
    ...(undo ? ['Undo'] : []),
    'Done',
  ];
}
function expectedHosted(marked: string, target = defaultHighlightPath, blockId?: string): string {
  // Compare complete native Markdown, including every host citation and paragraph anchor.
  // An explicit prior anchor also proves adjustments/Undo do not invent a new paragraph ID.
  let body = marked;
  for (let index = 0; index < passages(body).length; index++)
    body = hostPassage(body, passages(body)[index], [target]).body;
  if (blockId) {
    const anchors = paragraphAnchors(body);
    expect(anchors).toHaveLength(1);
    body =
      body.slice(0, anchors[0].anchor.from) + ` ^${blockId}` + body.slice(anchors[0].anchor.to);
  }
  return body;
}
function expectedRemovedHosted(marked: string, target = defaultHighlightPath): string {
  let body = expectedHosted(marked, target);
  for (const passage of passages(body).reverse()) body = changePassage(body, passage, 'remove');
  return body;
}
async function rememberDefaultHost(f: ReturnType<typeof hostFixture>, file: TFile) {
  const raw = await f.vault.process(file, (current) =>
    patchProperties(current, {
      topics: [`[[${defaultHighlightPath.replace(/\.md$/, '')}]]`],
    }),
  );
  f.cache.get(file).frontmatter = readDocument(raw).properties;
  f.store.catalog.update(file.path, readDocument(raw).properties);
}
function menu(view: ReaderView, title: string) {
  const probe = view as any;
  const passage = passages(probe.snapshot.body)[0];
  probe.passageMenu(passage, new MouseEvent('click'));
  if (title === 'Choose from article…') {
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'pick-in-article',
      nodes: probe.typedDestinations(passage.hosts ?? []),
    });
    passageButton(view, 'Add highlight to notes…').click();
  } else passageButton(view, title).click();
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
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (file, update) => {
      started.resolve();
      await finish.promise;
      return process(file, update);
    });
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
    await enableHighlightHost(f, file);
    await f.view.openArticle(file.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    surface.marker = 'words';
    f.probe.selectionChanged();
    await f.view.onClose();
    const saved = readDocument(await f.vault.read(file));
    expect(saved.body).toBe(expectedHosted('before ==words== after'));
    expect(saved.properties.bookmark).toBe('words');
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
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (file, update) => {
      started.resolve();
      await finish.promise;
      return process(file, update);
    });
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
    const navigating = f.view.openArticle(b.path);
    finish.resolve();
    await navigating;
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
    await enableHighlightHost(f, file);
    await f.view.openArticle(file.path);
    f.probe.surface.selectionValue = {
      quote: 'words',
      before: 'First ',
      after: ' end. Second words stop.',
    };
    const firstExpected = hostSelection(
      'First words end. Second words stop.',
      f.probe.surface.selectionValue,
      [defaultHighlightPath],
    ).body;
    await f.probe.saveSelection();
    expect((await f.store.read(file.path)).body).toBe(firstExpected);
    f.probe.surface.selectionValue = {
      quote: 'words',
      before: 'First words end. Second ',
      after: ' stop.',
    };
    await f.probe.saveSelection();
    const saved = (await f.store.read(file.path)).body;
    expect(saved).toBe(
      hostSelection(firstExpected, f.probe.surface.selectionValue, [defaultHighlightPath]).body,
    );
    expect(paragraphAnchors(saved)).toHaveLength(1);
    expect(paragraphAnchors(saved)[0].blockId).toBe(paragraphAnchors(firstExpected)[0].blockId);
  });
});

describe('automatic selection event ownership', () => {
  let f: Awaited<ReturnType<typeof selectionFixture>>;
  async function selectionFixture(remember = true) {
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
    const highlight = await enableHighlightHost(f, ...(remember ? [article] : []));
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
    return { ...f, article, body, surface, select, highlight };
  }
  beforeEach(async ({ task }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Bottom-navigation cases start unassociated; a remembered host makes Delete protected.
    f = await selectionFixture(!task.name.startsWith('uses the real bottom '));
  });
  afterEach(() => {
    f?.view.stopForUnload();
    document.getSelection()?.removeAllRanges();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('does not serialize text or update status during live selection adjustments or pointer holds', async () => {
    const capture = vi.spyOn(f.surface, 'selection'),
      status = vi.spyOn(f.probe, 'updateStatus'),
      serialize = vi.spyOn(Range.prototype, 'toString'),
      selectionText = vi.spyOn(document.getSelection()!, 'toString');
    gesture('pointerdown', f.surface.body, 'mouse');
    for (let i = 0; i < 20; i++) f.select(i % 2);
    vi.advanceTimersByTime(1200);
    expect(capture).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(selectionText).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    gesture('pointerup', f.surface.body, 'mouse');
    for (let i = 0; i < 20; i++) f.select(i % 2);
    vi.advanceTimersByTime(899);
    expect(capture).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(selectionText).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await f.probe.operations;
    expect(capture).toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('Alpha phrase.\n\n==Beta== phrase.'),
    );
  });

  it('rejects a range changed without selectionchange before the quiet timer fires', async () => {
    const capture = vi.spyOn(f.surface, 'selection');
    f.select(0);
    // jsdom also queues its own selectionchange task; hold delivery, as a native
    // event can remain queued when the quiet-period timer gets its turn first.
    vi.spyOn(f.probe, 'selectionChanged').mockImplementation(() => {});
    f.select(1, 4, false);
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect(capture).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
  });

  it('mounts one aligned article column with six persistent actions outside the scroller', () => {
    const column = f.view.contentEl.querySelector('.reader-article')!;
    const actions = column.querySelector('.reader-actions')!;
    expect([...actions.querySelectorAll('button')].map(actionName)).toEqual([
      'Related notes',
      'Change status',
      'Delete',
      'List',
      'Highlight mode',
      'Create node',
    ]);
    expect(actions.parentElement).toBe(f.surface.viewport.parentElement);
    expect(f.surface.viewport.contains(actions)).toBe(false);
    expect([...f.surface.flow.children]).toEqual([
      f.surface.title,
      f.surface.topics,
      f.surface.body,
    ]);
    expect(f.view.contentEl.querySelector('.reader-toolbar,.reader-finish')).toBeNull();
    expect(f.view.contentEl.textContent).not.toContain('End of article');
  });

  function armTapHighlight() {
    f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Highlight mode"]')!.click();
  }
  function tapAction(label: string) {
    return [
      ...f.view.contentEl.querySelectorAll<HTMLButtonElement>(
        '.reader-tap-highlight-actions button',
      ),
    ].find((button) => button.getAttribute('aria-label') === label)!;
  }
  async function tapWord(start = 0, end = 5, paragraph = 0) {
    const { TapText } = await import('../src/reader/tap-text');
    const range = document.createRange();
    const node = f.surface.body.querySelectorAll('p')[paragraph].firstChild!;
    range.setStart(node, start);
    range.setEnd(node, end);
    vi.spyOn(TapText.prototype, 'wordAt').mockReturnValueOnce(range);
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      });
      Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true });
      f.surface.body.dispatchEvent(event);
    }
    f.surface.body.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }),
    );
  }
  async function tapSettled() {
    await f.probe.operations;
    await Promise.resolve();
  }

  it.each([
    ['s', 'Sentence'],
    ['p', 'Paragraph'],
  ])('uses %s after the first tapped word to save a %s highlight', async (key, label) => {
    armTapHighlight();
    const before = new KeyboardEvent('keydown', { key, cancelable: true });
    f.view.key(before);
    expect(before.defaultPrevented).toBe(false); // Disabled until the first word.
    await tapWord();
    expect(tapAction(label).disabled).toBe(false);
    const event = new KeyboardEvent('keydown', { key, cancelable: true });
    f.view.key(event);
    expect(event.defaultPrevented).toBe(true);
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha phrase.==\n\nBeta phrase.'),
    );
    expect(f.probe.tapHighlighter.active).toBe(true);
    expect(tapAction('Done').getAttribute('aria-keyshortcuts')).toBe('D');
    const done = new KeyboardEvent('keydown', { key: 'd', cancelable: true });
    f.view.key(done);
    expect(done.defaultPrevented).toBe(true);
    expect(f.probe.tapHighlighter.active).toBe(false);
  });

  it.each(['Sentence', 'Paragraph'])(
    'saves a tap-%s highlight immediately through the guarded store and supports Undo',
    async (action) => {
      const bar = f.view.contentEl.querySelector('.reader-actions');
      armTapHighlight();
      expect(tapAction(action).disabled).toBe(true);
      await tapWord();
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      expect(tapAction(action).disabled).toBe(false);
      tapAction(action).click();
      await tapSettled();
      expect((await f.store.read(f.article.path)).body).toBe(
        expectedHosted('==Alpha phrase.==\n\nBeta phrase.'),
      );
      expect(f.surface.body.querySelector('mark')?.textContent).toBe('Alpha phrase.');
      expect(document.getSelection()?.isCollapsed).toBe(true);
      expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true, undo: true }));
      expect(f.view.contentEl.querySelector('.reader-actions')).toBe(bar);
      expect(f.probe.tapHighlighter.active).toBe(true);
      expect(f.view.contentEl.querySelector('[aria-label="Sentence"]')).toBeNull();
      expectNoPassagePopup();
      expect(tapAction('Undo').hidden).toBe(false);
      tapAction('Undo').click();
      await tapSettled();
      expect((await f.store.read(f.article.path)).body).toBe(
        expectedRemovedHosted('==Alpha phrase.==\n\nBeta phrase.'),
      );
      expect(f.surface.body.querySelector('mark')).toBeNull();
      expect(tapAction('Undo').hidden).toBe(true);
      expect(passageLabels(f.view)).toEqual(['Sentence', 'Paragraph', 'Done']);
    },
  );

  it('Undo synchronously cancels an uncooperative picker before queuing and clears passage actions', async () => {
    const target = await f.note('Nodes/Undo target.md', '', 'topic');
    const node: NodeResult = {
      path: target.path,
      title: 'Undo target',
      type: 'topic',
      classes: ['topic'],
      aliases: [],
    };
    const entered = gate();
    let requestSignal!: AbortSignal;
    let callback!: (node: NodeResult) => Promise<void>;
    const api: NodesApi = {
      ...f.highlight.api,
      searchNodes: () => [f.highlight.node, node],
      getNode: (path) => (path === node.path ? node : f.highlight.api.getNode(path)),
      createNodeForLink: (options, link) => {
        requestSignal = options.signal!;
        callback = link;
        entered.resolve();
        return new Promise(() => {});
      },
    };
    mocks.highlightPicker.mockResolvedValue({ kind: 'create', type: 'topic', title: node.title });
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    tapAction('Add highlight to notes…').click();
    await entered.promise;
    expect(requestSignal.aborted).toBe(false);
    tapAction('Undo').click();
    expect(requestSignal.aborted).toBe(true);
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedRemovedHosted('==Alpha phrase.==\n\nBeta phrase.'),
    );
    expect(passageLabels(f.view)).toEqual(['Sentence', 'Paragraph', 'Done']);
    expect(f.probe.dialog).toBe(false);
    await expect(callback(node)).rejects.toThrow(/finished|cancelled/);
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedRemovedHosted('==Alpha phrase.==\n\nBeta phrase.'),
    );
    expect(f.vault.file(target.path)).toBe(target);
  });

  it('saves only on the second word tap and restores article actions with one Done press', async () => {
    armTapHighlight();
    await tapWord();
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
    await tapWord();
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
    );
    tapAction('Done').click();
    expect(f.view.contentEl.querySelectorAll('.reader-actions > button')).toHaveLength(6);
    expect(f.view.contentEl.querySelector('.reader-tap-highlight-actions')).toBeNull();
    expect(f.probe.tapMode).toBe(false);
    expect(f.surface.body.classList.contains('reader-tap-highlight-mode')).toBe(false);
  });

  it('preserves a staged word across metadata changes and Undo never reverses Feed promotion', async () => {
    await f.probe.move('Feed');
    armTapHighlight();
    await tapWord();
    const raw = patchProperties(await f.vault.read(f.article), {
      title: 'Changed title',
    });
    f.vault.bytes.set(f.article, raw);
    f.store.catalog.update(f.article.path, readDocument(raw).properties);
    await f.view.changed({ path: f.article.path });
    expect(tapAction('Sentence').disabled).toBe(false);
    tapAction('Sentence').click();
    await tapSettled();
    expect((await f.store.read(f.article.path)).properties.status).toBe('later');
    tapAction('Undo').click();
    await tapSettled();
    const saved = await f.store.read(f.article.path);
    expect(saved.body).toBe(expectedRemovedHosted('==Alpha phrase.==\n\nBeta phrase.'));
    expect(saved.properties.status).toBe('later');
    expect(saved.properties.title).toBe('Changed title');
  });

  it('Undo removes only its highlight and preserves metadata edited after the save', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const raw = patchProperties(await f.vault.read(f.article), {
      title: 'Edited after highlight',
      custom_property: 'Keep this value',
    });
    f.vault.bytes.set(f.article, raw);
    f.store.catalog.update(f.article.path, readDocument(raw).properties);
    await f.view.changed({ path: f.article.path });
    tapAction('Undo').click();
    await tapSettled();
    const saved = await f.store.read(f.article.path);
    expect(saved.body).toBe(expectedRemovedHosted('==Alpha phrase.==\n\nBeta phrase.'));
    expect(saved.properties.title).toBe('Edited after highlight');
    expect(saved.properties.custom_property).toBe('Keep this value');
  });

  it('refuses Undo against changed source bytes even before their metadata notification arrives', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const saved = await f.store.read(f.article.path);
    const changedBody = saved.body + '\n\nExternally authored paragraph.';
    const raw = replaceBody(await f.vault.read(f.article), saved.body, changedBody);
    f.vault.bytes.set(f.article, raw);
    tapAction('Undo').click();
    await expect(tapSettled()).rejects.toThrow('The note changed');
    expect((await f.store.read(f.article.path)).body).toBe(changedBody);
    expect(tapAction('Undo').hidden).toBe(true);
  });

  it('invalidates a staged word on external body replacement without applying it to the new text', async () => {
    armTapHighlight();
    await tapWord();
    const raw = replaceBody(await f.vault.read(f.article), f.body, 'Replacement article.');
    f.vault.bytes.set(f.article, raw);
    f.store.catalog.update(f.article.path, readDocument(raw).properties);
    await f.view.changed({ path: f.article.path });
    expect(tapAction('Sentence').disabled).toBe(true);
    expect((await f.store.read(f.article.path)).body).toBe('Replacement article.');
    expect(f.surface.body.textContent).toContain('Replacement article.');
  });

  it('clears a staged word on Done or article exit and never flushes it as a native highlight', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Done').click();
    vi.advanceTimersByTime(1200);
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
    armTapHighlight();
    await tapWord();
    f.view.showList();
    vi.advanceTimersByTime(7000);
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
    expect(f.view.contentEl.querySelector('.reader-tap-highlight-preview')).toBeNull();
  });

  it('expires Undo and suppresses article shortcuts while the contextual highlight bar is active', async () => {
    armTapHighlight();
    f.view.key(new KeyboardEvent('keydown', { key: 'j' }));
    await tapSettled();
    expect(f.view.file).toBe(f.article);
    await tapWord();
    tapAction('Paragraph').click();
    await tapSettled();
    expect(tapAction('Undo').hidden).toBe(false);
    vi.advanceTimersByTime(6000);
    expect(tapAction('Undo').hidden).toBe(true);
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true }));
    expectNoPassagePopup();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha phrase.==\n\nBeta phrase.'),
    );
  });

  it('keeps passive native-selection saves outside tap mode until the saved mark is tapped', async () => {
    f.select(0);
    vi.advanceTimersByTime(900);
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
    );
    expect(f.probe.tapMode).toBe(false);
    expect(f.view.contentEl.querySelector('[aria-label="Highlight mode"]')).not.toBeNull();
    expect(f.view.contentEl.querySelector('[aria-label="Done"]')).toBeNull();
    document.getSelection()!.removeAllRanges();
    f.surface.refresh();
    f.surface.body
      .querySelector('mark')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true }));
    expect(f.probe.tapHighlighter.active).toBe(true);
    expectNoPassagePopup();
  });

  it.each([false, true])(
    'opens an existing mark in the same bar and removes only the tapped occurrence (already active=%s)',
    async (active) => {
      const body = '==Alpha phrase.==\n\n==Beta phrase.==';
      f.vault.bytes.set(f.article, replaceBody(await f.vault.read(f.article), f.body, body));
      await f.view.changed({ path: f.article.path });
      const bar = f.view.contentEl.querySelector('.reader-actions');
      if (active) armTapHighlight();
      const mark = f.surface.body.querySelectorAll('mark')[1];
      if (active) {
        const { TapText } = await import('../src/reader/tap-text');
        const word = document.createRange();
        word.setStart(mark.firstChild!, 0);
        word.setEnd(mark.firstChild!, 4);
        vi.spyOn(TapText.prototype, 'wordAt').mockReturnValueOnce(word);
      }
      mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(passageLabels(f.view)).toEqual(expectedPassageActions());
      expect(f.view.contentEl.querySelector('.reader-actions')).toBe(bar);
      expect(f.probe.tapHighlighter.active).toBe(true);
      expectNoPassagePopup();
      passageButton(f.view, 'Remove highlight (article only)').click();
      await tapSettled();
      expect((await f.store.read(f.article.path)).body).toBe('==Alpha phrase.==\n\nBeta phrase.');
      expect(passageLabels(f.view)).toEqual(['Sentence', 'Paragraph', 'Done']);
      expect(tapAction('Sentence').disabled).toBe(true);
      expect(f.probe.tapHighlighter.active).toBe(true);
    },
  );

  it('starts the next word selection from a saved passage bar and ignores its detached action', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const oldRemove = passageButton(f.view, 'Remove highlight (article only)');
    const annotate = vi.spyOn(f.store, 'collectHighlight');
    await tapWord(0, 4, 1);
    expect(f.view.contentEl.querySelector('[data-action="remove-highlight"]')).toBeNull();
    expect(tapAction('Sentence').disabled).toBe(false);
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha phrase.==\n\nBeta phrase.'),
    );
    oldRemove.click();
    await tapSettled();
    expect(annotate).not.toHaveBeenCalled();
    tapAction('Sentence').click();
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha phrase.==\n\n==Beta phrase.=='),
    );
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true, undo: true }));
    expectNoPassagePopup();
  });

  it('preserves saved passage context for metadata-only changes and clears it on a body change', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const body = (await f.store.read(f.article.path)).body;
    const raw = patchProperties(await f.vault.read(f.article), {
      title: 'Metadata only',
      custom: 'keep',
    });
    f.vault.bytes.set(f.article, raw);
    f.store.catalog.update(f.article.path, readDocument(raw).properties);
    await f.view.changed({ path: f.article.path, metadataChanged: true });
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true, undo: true }));
    expect((await f.store.read(f.article.path)).body).toBe(body);
    const staleRemove = passageButton(f.view, 'Remove highlight (article only)');
    const replacement = replaceBody(raw, body, 'Replacement article.');
    f.vault.bytes.set(f.article, replacement);
    await f.view.changed({ path: f.article.path });
    expect(passageLabels(f.view)).toEqual(['Sentence', 'Paragraph', 'Done']);
    staleRemove.click();
    await tapSettled();
    expect(await f.vault.read(f.article)).toBe(replacement);
    expect(tapAction('Sentence').disabled).toBe(true);
    expectNoPassagePopup();
  });

  it('refuses a passage action against changed source bytes before a change notification', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const body = (await f.store.read(f.article.path)).body;
    const replacement = replaceBody(
      await f.vault.read(f.article),
      body,
      body + '\n\nExternal text.',
    );
    f.vault.bytes.set(f.article, replacement);
    passageButton(f.view, 'Remove highlight (article only)').click();
    await expect(tapSettled()).rejects.toThrow('The note changed');
    expect(await f.vault.read(f.article)).toBe(replacement);
    expectNoPassagePopup();
  });

  it('refreshes destination/unlink passage actions against the saved body and Remove preserves the words', async () => {
    const target = await f.note('Nodes/One.md', 'Keep the target', 'topic');
    const node: NodeResult = {
      path: target.path,
      title: 'One',
      type: 'topic',
      classes: ['topic'],
      aliases: [],
    };
    const api: NodesApi = {
      ...f.highlight.api,
      searchNodes: () => [f.highlight.node, node],
      getNode: (path) => (path === node.path ? node : f.highlight.api.getNode(path)),
    };
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node });
    const bar = f.view.contentEl.querySelector('.reader-actions');
    const targetBefore = await f.vault.read(target);
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const blockId = paragraphAnchors((await f.store.read(f.article.path)).body)[0].blockId;
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true, undo: true }));
    passageButton(f.view, 'Add highlight to notes…').click();
    await tapSettled();
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      api,
      expect.objectContaining({
        query: '',
        title: 'Add highlight to notes',
        multiple: true,
        minSelection: 0,
        selectedPaths: [defaultHighlightPath],
        signal: expect.any(AbortSignal),
      }),
    );
    expect(api.pickNodeForLink).not.toHaveBeenCalled();
    const linked = expectedHosted('==Alpha phrase.==\n\nBeta phrase.', target.path, blockId);
    expect((await f.store.read(f.article.path)).body).toBe(linked);
    expect(passageLabels(f.view).filter((label) => label !== 'Undo')).toEqual(
      expectedPassageActions({ linked: true }),
    );
    expect(f.view.contentEl.querySelector('.reader-actions')).toBe(bar);
    const collected = appendQuotation(
      targetBefore,
      'Alpha phrase.',
      originLink(f.article.path, blockId, f.article.basename),
    ).raw;
    expect(await f.vault.read(target)).toBe(collected);
    passageButton(f.view, 'Remove references (article only)').click();
    await tapSettled();
    const unlinked = changePassage(linked, passages(linked)[0], 'unlink');
    expect((await f.store.read(f.article.path)).body).toBe(unlinked);
    expect(passageLabels(f.view).filter((label) => label !== 'Undo')).toEqual(
      expectedPassageActions(),
    );
    passageButton(f.view, 'Remove highlight (article only)').click();
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      changePassage(unlinked, passages(unlinked)[0], 'remove'),
    );
    expect((await f.store.read(f.article.path)).properties.topics).toEqual([
      '[[Nodes/Default]]',
      '[[Nodes/One]]',
    ]);
    expect(passageLabels(f.view)).toEqual(['Sentence', 'Paragraph', 'Done']);
    expect(f.probe.tapHighlighter.active).toBe(true);
    expect(await f.vault.read(target)).toBe(collected);
    expect(f.vault.trashed).toEqual([]);
    expectNoPassagePopup();
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
      const annotate = vi.spyOn(f.store, 'collectHighlight'),
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
      expect((await f.store.read(f.article.path)).body).toBe(
        expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
      );
      expect(document.getSelection()!.toString()).toBe('Alpha');
      expect(workspace).not.toHaveBeenCalled();
    },
  );

  it.each(['pointerup', 'pointercancel'])(
    'saves pointer-only desktop selection after stopped %s and Surface capture release',
    async (release) => {
      const annotate = vi.spyOn(f.store, 'collectHighlight');
      f.surface.body.addEventListener(release, (event) => event.stopPropagation(), { once: true });
      gesture('pointerdown', f.surface.body, 'mouse', 17);
      f.select(0); // selectionchange arrives before release, while both trackers are held.
      vi.advanceTimersByTime(1200);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      gesture(release, f.surface.body, 'mouse', 17);
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

  it.each(
    ['pointerup', 'pointercancel'].flatMap((pointerRelease) =>
      ['touchend', 'touchcancel'].flatMap((touchRelease) =>
        [true, false].map((pointerFirst) => ({ pointerRelease, touchRelease, pointerFirst })),
      ),
    ),
  )(
    'observes stopped mixed-stream termination: $pointerRelease / $touchRelease, pointer first=$pointerFirst',
    async ({ pointerRelease, touchRelease, pointerFirst }) => {
      const annotate = vi.spyOn(f.store, 'collectHighlight');
      const target = f.surface.body;
      for (const type of [pointerRelease, touchRelease])
        target.addEventListener(type, (event) => event.stopPropagation(), { once: true });
      gesture('pointerdown', target, 'touch', 17);
      gesture('touchstart', target, 'touch', 42);
      f.select(0);
      const pointer = () => gesture(pointerRelease, target, 'touch', 17);
      const touch = () => gesture(touchRelease, target, 'touch', 42);
      (pointerFirst ? pointer : touch)();
      vi.advanceTimersByTime(1200);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      expect(f.probe.selecting).toBe(true);
      (pointerFirst ? touch : pointer)();
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

  function nativeTouch(type: string, changed: number[], active?: number[]): void {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, {
      changedTouches: changed.map((identifier) => ({ identifier })),
      ...(active === undefined ? {} : { touches: active.map((identifier) => ({ identifier })) }),
    });
    f.surface.body.dispatchEvent(event);
  }

  it.each(['touchend'])(
    'reconciles accumulated iOS pointers only at authoritative empty %s',
    async (release) => {
      const annotate = vi.spyOn(f.store, 'collectHighlight');
      gesture('pointerdown', f.surface.body, 'touch', 17);
      nativeTouch('touchstart', [42], [42]);
      gesture('pointerdown', f.surface.body, 'touch', 18);
      nativeTouch('touchstart', [43], [42, 43]);
      f.select(0);
      nativeTouch(release, [42, 43], [99]); // Active touch can be outside Reader.
      vi.advanceTimersByTime(1200);
      expect(f.probe.selecting).toBe(true);
      expect(f.surface.pointerActive).toBe(true);
      expect(annotate).not.toHaveBeenCalled();
      // A later pointerdown is not proof that earlier pointers lifted.
      gesture('pointerdown', f.surface.body, 'touch', 19);
      nativeTouch('touchstart', [44], [44]);
      nativeTouch(release, [44]); // Missing native list remains conservative.
      vi.advanceTimersByTime(1200);
      expect(f.probe.selecting).toBe(true);
      expect(f.surface.pointerActive).toBe(true);
      expect(annotate).not.toHaveBeenCalled();
      nativeTouch('touchcancel', [], []); // Native takeover is not proof of lift.
      vi.advanceTimersByTime(1200);
      expect(f.probe.selecting).toBe(true);
      expect(f.surface.pointerActive).toBe(true);
      expect(annotate).not.toHaveBeenCalled();
      nativeTouch(release, [], []); // Also clears stale native touch identifiers.
      expect(f.probe.selecting).toBe(false);
      expect(f.surface.pointerActive).toBe(false);
      vi.advanceTimersByTime(899);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await f.probe.operations;
      expect(annotate).toHaveBeenCalledOnce();
    },
  );

  it('does not treat a lone zero-touch cancellation as a missing pointer release', async () => {
    const annotate = vi.spyOn(f.store, 'collectHighlight');
    gesture('pointerdown', f.surface.body, 'touch', 17);
    nativeTouch('touchstart', [42], [42]);
    f.select(0);
    nativeTouch('touchcancel', [42], []);
    vi.advanceTimersByTime(1200);
    await f.probe.operations;
    expect(f.probe.selecting).toBe(true);
    expect(f.surface.pointerActive).toBe(true);
    expect(annotate).not.toHaveBeenCalled();
  });

  it('keeps simultaneous mouse and pen guards after native touches lift', async () => {
    const annotate = vi.spyOn(f.store, 'collectHighlight');
    for (const [id, kind] of [
      [17, 'touch'],
      [18, 'mouse'],
      [19, 'pen'],
    ] as const)
      gesture('pointerdown', f.surface.body, kind, id);
    nativeTouch('touchstart', [42], [42]);
    f.select(0);
    nativeTouch('touchend', [], []);
    gesture('pointerup', f.surface.body, 'mouse', 18);
    vi.advanceTimersByTime(1200);
    expect(f.probe.selecting).toBe(true);
    expect(f.surface.pointerActive).toBe(true);
    expect(annotate).not.toHaveBeenCalled();
    gesture('pointerup', f.surface.body, 'pen', 19);
    expect(f.probe.selecting).toBe(false);
    expect(f.surface.pointerActive).toBe(false);
    vi.advanceTimersByTime(899);
    await f.probe.operations;
    expect(annotate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await f.probe.operations;
    expect(annotate).toHaveBeenCalledOnce();
  });

  it('restarts the full 900ms quiet period for every adjustment, including repeated text', async () => {
    const annotate = vi.spyOn(f.store, 'collectHighlight');
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
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('Alpha phrase.\n\n==Beta== phrase.'),
    );
    expect(document.getSelection()!.toString()).toBe('Beta');
  });

  it.each(['pointerup', 'pointercancel', 'touchend', 'touchcancel'])(
    'retains the outside-Reader %s fallback and its full quiet period',
    async (release) => {
      const annotate = vi.spyOn(f.store, 'collectHighlight');
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
        annotate = vi.spyOn(f.store, 'collectHighlight');
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
    const annotate = vi.spyOn(f.store, 'collectHighlight');
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
    const annotate = vi.spyOn(f.store, 'collectHighlight'),
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
      expect((await f.store.read(f.article.path)).body).toBe(
        expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
      );
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
        annotate = vi.spyOn(f.store, 'collectHighlight');
      vi.advanceTimersByTime(900);
      await f.probe.operations;
      expect(await f.vault.read(f.article)).toBe(before);
      expect(annotate).not.toHaveBeenCalled();
      expect(mocks.notice).not.toHaveBeenCalled();
      await expect(f.probe.saveSelection()).rejects.toThrow('cannot be matched safely');
    },
  );

  it.each(['Archive', 'Delete', 'Next'])(
    'uses the status picker, Delete button or J shortcut to advance via %s',
    async (label) => {
      const next = await f.note('Reading/Inbox/Z next.md');
      await f.view.openArticle(f.article.path, true);
      const original = await f.vault.read(f.article),
        originalPath = f.article.path;
      const click = (name: string) =>
        [...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button')]
          .find((button) => actionName(button) === name)!
          .click();
      if (label === 'Archive') {
        mocks.choose.mockResolvedValueOnce('Archive');
        click('Change status');
      } else if (label === 'Next') {
        const event = new KeyboardEvent('keydown', { key: 'j', cancelable: true });
        f.view.key(event);
        expect(event.defaultPrevented).toBe(true);
      } else click(label);
      if (label === 'Archive') await Promise.resolve(); // Picker resolves before finish queues its operation.
      await f.probe.operations;
      expect(f.view.file).toBe(next);
      expect(f.vault.trashed).toEqual([]); // Protected annotated article is retained.
      expect(await f.vault.read(f.article)).toBe(
        patchProperties(original, {
          dog_ear: undefined,
          ...(label === 'Next' ? {} : { status: 'archive' }),
        }),
      );
      expect(f.article.path).toBe(
        label === 'Next' ? originalPath : 'Reading/Treasury/Selection.md',
      );
      const nextKey = new KeyboardEvent('keydown', { key: 'j', cancelable: true });
      f.view.key(nextKey);
      expect(nextKey.defaultPrevented).toBe(true);
      await f.probe.operations;
      expect(f.view.file).toBeUndefined(); // Last-article J returns to the list.
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
      expect((await f.store.read(f.article.path)).body).toBe(
        expectedHosted('Alpha phrase.\n\n==Beta== phrase.'),
      );
      if (wait === 'position')
        expect((await f.store.read(f.article.path)).properties.bookmark).toBe('position sentinel');
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
        expectedHosted(
          kind === 'unreported'
            ? 'Alpha phrase.\n\n==Beta== phrase.'
            : '==Alpha== phrase.\n\nBeta phrase.',
        ),
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
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('Alpha phrase.\n\n==Beta== phrase.'),
    );
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
    const blockId = paragraphAnchors((await f.store.read(f.article.path)).body)[0].blockId;
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
    );
    expect(f.surface.displayedBody).toBe(f.body);
    expect(document.getSelection()!.toString()).toBe('Alpha');
    f.select(0, 12);
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha phrase==.\n\nBeta phrase.', defaultHighlightPath, blockId),
    );
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(f.surface.displayedBody).toBe(
      expectedHosted('==Alpha phrase==.\n\nBeta phrase.', defaultHighlightPath, blockId),
    );
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect([...f.surface.body.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
      'Alpha phrase',
    ]);
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it('preserves its own Feed promotion during an automatic highlight', async () => {
    const moved = await f.store.move(await f.store.read(f.article.path), 'Feed');
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
    expect(f.article.path).toBe('Reading/Later/Selection.md');
    expect((await f.store.read(f.article.path)).properties.status).toBe('later');
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
    );
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
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
    );
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\n==Beta== phrase.'),
    );
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
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('Alpha phrase.\n\n==Beta== phrase.'),
    );
    expect(mocks.notice).not.toHaveBeenCalled();
  });
});

describe('displayed source and deferred rendering', () => {
  it('rejects stale selection, passage, move, topic, trash and position actions while newer source is deferred', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', 'before ==words== after');
    enableTypedTopics(f);
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
    await enableHighlightHost(f, article);
    await f.view.openArticle(article.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    await f.probe.saveSelection();
    const first = expectedHosted('before ==words== after');
    expect((await f.store.read(article.path)).body).toBe(first);
    const blockId = paragraphAnchors(first)[0].blockId;
    expect(surface.displayedBody).toBe('before words after');
    surface.selectionValue = { quote: 'words after', before: 'before ', after: '' };
    await f.probe.saveSelection();
    expect((await f.store.read(article.path)).body).toBe(
      expectedHosted('before ==words after==', defaultHighlightPath, blockId),
    );
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
    await enableHighlightHost(f, article);
    await f.view.openArticle(article.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    const closing = f.view.onClose();
    surface.selectionValue = undefined;
    await closing;
    expect((await f.store.read(article.path)).body).toBe(expectedHosted('before ==words== after'));
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
    enableTypedTopics(f);
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
    expect((await f.store.read(article.path)).properties.status).toBe('later');
    expect(await f.vault.read(article)).toBe(patchProperties(before, { status: 'later' }));
    command('topics', false);
    await f.probe.operations;
    expect(mocks.highlightPicker).toHaveBeenCalledOnce();
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      expect.any(Object),
      expect.objectContaining({ title: 'Related notes', actionLabel: 'Apply', multiple: true }),
    );
    expect(mocks.topics).not.toHaveBeenCalled();
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

describe('public dog-ear command and URI', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('moves the dog ear on next navigation without changing either reading-position bookmark', async () => {
    const f = hostFixture();
    const first = await f.note('Reading/Inbox/A.md', 'first article');
    const second = await f.note('Reading/Inbox/B.md', 'second article');
    await f.view.openArticle(first.path, true);
    expect((await f.store.read(first.path)).properties.dog_ear).toBe(true);
    await f.view.navigate(1);
    expect(f.view.file).toBe(second);
    expect((await f.store.read(first.path)).properties).not.toHaveProperty('dog_ear');
    expect((await f.store.read(second.path)).properties.dog_ear).toBe(true);
    expect((await f.store.read(first.path)).properties).not.toHaveProperty('bookmark');
  });
  it.each(['command', 'uri'])(
    'opens the marked article and falls back to newest Inbox (%s)',
    async (route) => {
      const f = await pluginFixture();
      const older = await f.note('Reading/Inbox/Older.md');
      const newest = await f.note('Reading/Inbox/Newest.md');
      vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
      // Same date: title sorts before path, so Older precedes Newest by title.
      const first = f.store.catalog.list('Inbox', '', 0, 1)[0].path;
      const invoke = () =>
        route === 'command'
          ? mocks.commands.get('open-dog-ear')!.callback!()
          : mocks.protocols.get('obsidian-reader')!({ view: 'dog-ear' });
      invoke();
      await vi.waitFor(() => expect(f.view.file?.path).toBe(first));
      await f.store.dogEar(first === older.path ? newest.path : older.path);
      invoke();
      await vi.waitFor(() =>
        expect(f.view.file?.path).toBe(first === older.path ? newest.path : older.path),
      );
    },
  );
  it('copies a vault-aware shortcut link only on request', async () => {
    const clipboard = { writeText: vi.fn(async (_link: string) => {}) };
    vi.stubGlobal('navigator', { clipboard });
    const f = await pluginFixture();
    vi.mocked(f.app.vault.getName).mockReturnValue('iPhone & Boox');
    expect(clipboard.writeText).not.toHaveBeenCalled();
    await mocks.commands.get('copy-dog-ear-link')!.callback!();
    expect(clipboard.writeText).toHaveBeenCalledWith(
      'obsidian://obsidian-reader?vault=iPhone%20%26%20Boox&view=dog-ear',
    );
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
      const highlight = await enableHighlightHost(f, article);
      await f.view.openArticle(article.path);
      vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
      expect(mocks.commands.get('open-reader')!.name).toBe('Open reading list');
      expect([...mocks.protocols.keys()]).toEqual(['obsidian-reader']);
      const pending = gate();
      f.probe.positionWrite = pending.promise;
      f.probe.surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
      f.probe.surface.marker = 'words';
      invoke(route);
      expect(f.view.file).toBe(article);
      pending.resolve();
      await f.probe.operations;
      expect(f.view.file).toBeUndefined();
      expect(f.view.contentEl.querySelector('.reader-list')).not.toBeNull();
      const saved = readDocument(await f.vault.read(article));
      expect(saved.body).toBe(expectedHosted('before ==words== after'));
      expect(saved.properties.bookmark).toBe('words');
      // Cancel a genuine Reader create intent separately: cancelling a modal's captured
      // selection must not replay that cancelled intent as a fresh automatic highlight.
      await f.view.openArticle(article.path);
      const beforeCancel = await f.vault.read(article),
        entered = gate();
      let requestSignal!: AbortSignal;
      highlight.api.createNodeForLink = (options) => {
        requestSignal = options.signal!;
        entered.resolve();
        return new Promise(() => {});
      };
      mocks.highlightPicker.mockResolvedValue({ kind: 'create', title: 'words', type: 'topic' });
      const creating = menu(f.view, 'Add highlight to notes…');
      await entered.promise;
      invoke(route);
      expect(requestSignal.aborted).toBe(true);
      await f.probe.operations;
      await creating;
      expect(f.view.file).toBeUndefined();
      expect(f.view.contentEl.querySelector('.reader-list')).not.toBeNull();
      expect(await f.vault.read(article)).toBe(beforeCancel);
      expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
    },
  );

  it.each(['command', 'uri'])(
    'keeps a failed source save mounted and reports it through the public %s route',
    async (route) => {
      const f = await pluginFixture();
      const article = await f.note('Reading/Inbox/Article.md');
      await enableHighlightHost(f, article);
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
      'Related notes',
      'Change status',
      'Delete',
      'List',
      'Highlight mode',
      'Create node',
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
      expect(setTooltip).toHaveBeenCalledWith(
        button,
        `${actionName(button)} (${button.dataset.readerKey!.toUpperCase()})`,
      );
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
      ).toEqual(['tags', 'list-filter', 'trash-2', 'list', 'highlighter', 'file-plus-2']);
      expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
        'Related notes',
        'Change status and advance · L: Later · A: Archive',
        'Trash article and advance',
        'List',
        'Highlight mode',
        'Create node',
      ]);
      expect(setTooltip).toHaveBeenCalledWith(buttons[0], 'Related notes (T)');
      expect(setTooltip).toHaveBeenCalledWith(
        buttons[1],
        'Change status and advance · L: Later · A: Archive',
      );
      expect(setTooltip).toHaveBeenCalledWith(
        f.probe.surface.title,
        'J: next article · K: previous article · ↑/↓ or Page Up/Down at article edges',
      );
      for (const button of buttons) {
        const css = window.getComputedStyle(button);
        expect(button.textContent).toBe('');
        expect(css.minWidth).toBe('44px');
        expect(css.minHeight).toBe('44px');
        if (!button.matches('.reader-tap-highlight-trigger,.reader-tap-node-trigger'))
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

describe('folder-authoritative queue presentation', () => {
  it.each([
    ['Reading/Stream/Misleading.md', {}, 'Feed', 'later', 'Reading/Later/Misleading.md'],
    [
      'Reading/Stream/Misleading.md',
      { status: 'inbox' },
      'Feed',
      'later',
      'Reading/Later/Misleading.md',
    ],
    [
      'Reading/Inbox/Misleading.md',
      { status: 'feed' },
      'Inbox',
      'feed',
      'Reading/Inbox/Misleading.md',
    ],
    [
      'Reading/Later/Misleading.md',
      { status: 'archive' },
      'Later',
      'archive',
      'Reading/Later/Misleading.md',
    ],
    [
      'Reading/Treasury/Misleading.md',
      { status: 'later' },
      'Archive',
      'later',
      'Reading/Treasury/Misleading.md',
    ],
    [
      'Unrelated/Inbox/Misleading.md',
      { status: 'inbox' },
      undefined,
      'inbox',
      'Unrelated/Inbox/Misleading.md',
    ],
  ] as const)(
    'folder wins over YAML and Feed annotation retains before saving: %s %j',
    async (path, properties, queue, savedStatus, finalPath) => {
      const f = hostFixture(),
        article = await f.note(path);
      const raw = createDocument({ type: 'article', ...properties }, 'before words after');
      f.vault.bytes.set(article, raw);
      f.store.catalog.update(article.path, readDocument(raw).properties);
      expect(f.store.catalog.article(article.path)?.queue).toBe(queue);
      await enableHighlightHost(f);
      await f.view.openArticle(article.path);
      expect(await f.vault.read(article)).toBe(patchProperties(raw, { dog_ear: true }));
      f.probe.surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
      await f.probe.saveSelection();
      const saved = await f.store.read(article.path);
      expect(saved.properties.status).toBe(savedStatus);
      expect(saved.body).toBe(expectedHosted('before ==words== after'));
      expect(article.path).toBe(finalPath);
      expect(f.store.catalog.article(article.path)?.queue).toBe(queue === 'Feed' ? 'Later' : queue);
    },
  );

  it('refreshes status-only metadata without remounting the article content', async () => {
    const f = hostFixture(),
      article = await f.note('Elsewhere/Article.md');
    await f.view.openArticle(article.path, true);
    const surface = f.probe.surface;
    surface.setBody.mockClear();
    await f.vault.process(article, (raw) => patchProperties(raw, { status: 'archive' }));
    await f.view.changed({ path: article.path, metadataChanged: true });
    expect(f.probe.snapshot.properties.status).toBe('archive');
    expect(f.probe.surface).toBe(surface);
    expect(surface.setBody).not.toHaveBeenCalled();
    expect(surface.dispose).not.toHaveBeenCalled();
    expect(f.view.getState()).toEqual({ file: article.path, queue: 'Inbox' });
    expect(
      f.view.contentEl.querySelector('[aria-label^="Change status and advance"]'),
    ).not.toBeNull();
  });

  it.each([undefined, 'words'])(
    'resumes bookmark only, never legacy position: %s',
    async (bookmark) => {
      const f = hostFixture(),
        article = await f.note('Elsewhere/Article.md');
      await f.vault.process(article, (raw) =>
        patchProperties(raw, { bookmark, reading_position: 'before' }),
      );
      const original = await f.vault.read(article);
      await f.view.openArticle(article.path);
      expect(f.probe.surface.restore).toHaveBeenCalledWith(bookmark ?? '');
      expect(await f.vault.read(article)).toBe(patchProperties(original, { dog_ear: true }));
    },
  );
});

describe('browsing context and presentation', () => {
  it('refreshes the native list title when a filter changes or clears without persisting it', () => {
    const f = hostFixture();
    const refresh = vi.fn(async () => {});
    f.host.refreshPresentation = refresh;
    f.view.showList();
    expect(f.view.getDisplayText()).toBe('Reading list');
    f.probe.topicFilter = { label: 'sea level', terms: ['sea level'] };
    f.view.showList();
    expect(f.view.getDisplayText()).toBe('Reading list: sea level');
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(f.view.getState()).toEqual({ file: undefined, queue: 'Inbox' });
    f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Filter by topic"]')!.click();
    expect(f.view.getDisplayText()).toBe('Reading list');
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(f.view.contentEl.querySelector('.reader-topic-filter-state')).toBeNull();
    f.view.stopForUnload();
  });
  it('returns a promoted article to the filtered list before clearing via the filter toggle', async () => {
    const f = hostFixture();
    const before = await f.note('Reading/Stream/A.md', 'sea level');
    const current = await f.note('Reading/Stream/B.md', 'sea level');
    const after = await f.note('Reading/Stream/C.md', 'sea level');
    const topic = await f.note('Topics/Sea.md', '', 'topic');
    for (const file of f.vault.files.values())
      Object.assign(file, { stat: { mtime: 1, size: f.vault.bytes.get(file)!.length } });
    f.probe.topicFilter = { label: 'sea level', terms: ['sea level'] };
    f.view.showList('Feed');
    for (let i = 0; i < 100; i++) await Promise.resolve();
    const api = enableTypedTopics(f);
    await f.view.openArticle(current.path, true);
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'existing-many',
      nodes: [api.getNode(topic.path)!],
    });
    await f.probe.topics();
    expect((await f.store.read(current.path)).properties.status).toBe('later');
    expect(f.view.getDisplayText()).toBe('Reader: B');
    expect(f.view.contentEl.querySelector('.reader-topic-filter-state')).toBeNull();
    await f.view.readingList();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(f.view.getDisplayText()).toBe('Reading list: sea level');
    const write = vi.spyOn(f.vault, 'process');
    f.host.ingestion.acquire.mockClear();
    f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Filter by topic"]')!.click();
    expect(f.view.getDisplayText()).toBe('Reading list');
    expect(f.probe.topicFilter).toBeUndefined();
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(2);
    expect(write).not.toHaveBeenCalled();
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
    await f.view.openArticle(before.path, true);
    await f.view.navigate(1);
    expect(f.view.file).toBe(after);
    f.view.stopForUnload();
  });
  it('navigates the actual filtered article snapshot next/previous and returns to the filtered list', async () => {
    const f = hostFixture();
    const first = await f.note('Reading/Inbox/A.md', 'sea level');
    await f.note('Reading/Inbox/B.md', 'unrelated');
    const last = await f.note('Reading/Inbox/C.md', 'SEA LEVEL');
    for (const file of f.vault.files.values())
      Object.assign(file, { stat: { mtime: 1, size: f.vault.bytes.get(file)!.length } });
    f.probe.topicFilter = { label: 'sea level', terms: ['sea level'] };
    f.view.showList();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(2);
    await f.view.openArticle(first.path, true);
    await f.view.navigate(1);
    expect(f.view.file).toBe(last);
    await f.view.navigate(-1);
    expect(f.view.file).toBe(first);
    expect(f.view.getDisplayText()).toBe('Reader: A');
    expect(f.view.contentEl.querySelector('.reader-topic-filter-state')).toBeNull();
    await f.view.readingList();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(2);
    expect(f.probe.topicFilter.label).toBe('sea level');
    expect(f.view.getDisplayText()).toBe('Reading list: sea level');
    f.view.stopForUnload();
  });
  it.each(['Inbox', 'Feed', 'Later', 'Archive'] as const)(
    'command-palette move to Later stays on the article from %s',
    async (queue) => {
      const folders = { ...defaultFolders, articles: 'Queues/Articles' };
      const f = hostFixture(folders);
      const folder = `Reading/${{ Inbox: 'Inbox', Feed: 'Stream', Later: 'Later', Archive: 'Treasury' }[queue]}`;
      const article = await f.note(`${folder}/A.md`, 'Article A'),
        next = await f.note(`${folder}/B.md`, 'Article B');
      f.view.showList(queue);
      await f.view.openArticle(article.path, true);
      const surface = f.probe.surface;
      surface.marker = 'Article A';
      const move = vi.spyOn(f.store, 'move');
      f.host.ingestion.acquire.mockClear();
      expect(
        f.view.contentEl.querySelector('[aria-label^="Change status and advance"]'),
      ).not.toBeNull();
      mocks.choose.mockResolvedValueOnce('Later');
      await f.probe.move();
      expect(mocks.choose).toHaveBeenCalledWith(
        f.app,
        'Change article status…',
        ['Inbox', 'Later', 'Feed', 'Archive'],
        expect.any(Function),
        expect.any(AbortSignal),
      );
      expect(move).toHaveBeenCalledWith(expect.anything(), 'Later');
      expect(article.path).toBe('Reading/Later/A.md');
      expect((await f.store.read(article.path)).properties.status).toBe('later');
      expect(f.view.file).toBe(article);
      expect(f.probe.surface).toBe(surface);
      expect(f.view.getState()).toEqual({ file: article.path, queue });
      const saved = readDocument(await f.vault.read(article));
      expect(saved.body).toBe('Article A');
      expect(saved.properties.bookmark).toBe('Article A');
      expect(f.host.ingestion.acquire).toHaveBeenCalledWith(article.path);
      expect(mocks.notice).toHaveBeenCalledWith('Saved to Later');
      mocks.choose.mockResolvedValueOnce('Later');
      await f.probe.move();
      expect(article.path).toBe('Reading/Later/A.md');
      expect((await f.store.read(article.path)).properties.status).toBe('later');
      await f.view.navigate(1);
      expect(f.view.file).toBe(next);
      await f.view.readingList();
      expect(f.view.getState().queue).toBe(queue);
    },
  );

  it('rejects a status choice when the displayed source has changed', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path, true);
    const external = createDocument({ type: 'article' }, 'External edit');
    f.vault.bytes.set(article, external);
    mocks.choose.mockResolvedValueOnce('Later');
    f.view.contentEl
      .querySelector<HTMLButtonElement>('[aria-label^="Change status and advance"]')!
      .click();
    await Promise.resolve(); // Let the selected choice queue the guarded write.
    await expect(f.probe.operations).rejects.toThrow();
    expect(article.path).toBe('Reading/Inbox/A.md');
    expect(await f.vault.read(article)).toBe(external);
    expect(f.view.file).toBe(article);
    expect(
      f.view.contentEl.querySelector('[aria-label^="Change status and advance"]'),
    ).not.toBeNull();
    expect(mocks.notice).not.toHaveBeenCalledWith('Saved to Later');
  });

  it('does not acknowledge Later when YAML saves but the folder move fails', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path, true);
    f.vault.failMove = true;
    mocks.choose.mockResolvedValueOnce('Later');
    f.view.contentEl
      .querySelector<HTMLButtonElement>('[aria-label^="Change status and advance"]')!
      .click();
    await Promise.resolve();
    await expect(f.probe.operations).rejects.toThrow('Move failed');
    expect((await f.store.read(article.path)).properties.status).toBe('later');
    expect(article.path).toBe('Reading/Inbox/A.md');
    expect(
      f.view.contentEl.querySelector('[aria-label^="Change status and advance"]'),
    ).not.toBeNull();
    expect(mocks.notice).not.toHaveBeenCalledWith('Saved to Later');
  });

  it('keeps the status picker after external folder moves and YAML changes without remounting', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path, true);
    const surface = f.probe.surface;
    const expectControls = () => {
      expect(
        f.view.contentEl.querySelector('[aria-label^="Change status and advance"]'),
      ).not.toBeNull();
      expect(f.probe.surface).toBe(surface);
    };
    // YAML alone cannot retain an Inbox article.
    await f.vault.process(article, (raw) => patchProperties(raw, { status: 'later' }));
    f.store.catalog.update(article.path, readDocument(await f.vault.read(article)).properties);
    await f.view.changed({ path: article.path, metadataChanged: true });
    expectControls();
    // Folder moves change queue membership without rewriting the stale YAML.
    for (const folder of ['Later', 'Treasury', 'Later', 'Outside']) {
      const previousPath = article.path;
      await f.vault.move(article, `Reading/${folder}/A.md`);
      f.store.catalog.rename(
        previousPath,
        article.path,
        readDocument(await f.vault.read(article)).properties,
      );
      await f.view.changed({ path: article.path, previousPath, metadataChanged: true });
      expectControls();
      if (folder === 'Later') {
        await f.vault.process(article, (raw) => patchProperties(raw, { status: 'archive' }));
        f.store.catalog.update(article.path, readDocument(await f.vault.read(article)).properties);
        await f.view.changed({ path: article.path, metadataChanged: true });
        expectControls();
      }
    }
    expect(mocks.notice).not.toHaveBeenCalledWith('Saved to Later');
  });

  it('keeps capture placement independent from Feed browsing and explicit Archive', async () => {
    const folders: ReaderFolders = {
      articles: 'Cache/Feed',
      feeds: 'Subscriptions',
    };
    const f = hostFixture(folders);
    const a = await f.note('Reading/Stream/A.md', '==Preserve this=='),
      b = await f.note('Reading/Stream/B.md', 'Next article');
    const rawA = f.vault.bytes.get(a),
      rawB = f.vault.bytes.get(b);
    const captured = await f.store.capture({ url: 'https://example.test/from-capture' });
    expect(captured.path).toMatch(/^Reading\/Inbox\//);
    expect((await f.store.read(captured.path)).properties.status).toBe('inbox');
    f.view.showList('Feed');
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(2);
    expect(a.path).toBe('Reading/Stream/A.md');
    await f.view.openArticle(a.path, true);
    expect(a.path).toBe('Reading/Stream/A.md');
    expect(f.view.getDisplayText()).toBe('Reader: A');
    await f.probe.finish('next');
    expect(f.view.file).toBe(b);
    mocks.choose.mockResolvedValueOnce('Archive');
    f.view.contentEl
      .querySelector<HTMLButtonElement>('[aria-label^="Change status and advance"]')!
      .click();
    await Promise.resolve();
    await f.probe.operations;
    expect(f.view.file).toBeUndefined();
    expect(b.path).toBe('Reading/Treasury/B.md');
    expect(f.vault.bytes.get(a)).toBe(rawA);
    expect(f.vault.bytes.get(b)).toBe(patchProperties(rawB!, { status: 'archive', dog_ear: true }));
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
  ])('opens a Feed article with native annotations without status writes: %s', async (body) => {
    const f = hostFixture(),
      a = await f.note('Reading/Stream/A.md', body),
      b = await f.note('Reading/Stream/B.md');
    f.view.showList('Feed');
    const move = vi.spyOn(f.store, 'move'),
      enumerate = vi.spyOn(f.app.vault, 'getMarkdownFiles');
    await f.view.openArticle(a.path, true);
    expect(move).not.toHaveBeenCalled();
    expect(enumerate).not.toHaveBeenCalled();
    expect(a.path).toBe('Reading/Stream/A.md');
    expect((await f.store.read(a.path)).properties.status).toBe('feed');
    expect((await f.store.read(a.path)).body).toBe(body);
    expect(f.view.getState().queue).toBe('Feed');
    await f.view.navigate(1);
    expect(f.view.file).toBe(b);
  });

  it.each([
    { properties: { related: '[[Topics/X.md]]' }, kept: true },
    { properties: { related: { nested: ['[[Topics/X.md]]'] } }, kept: true },
    {
      properties: { feed: '[[Reading/Wires/Feed.md]]', bookmark: 'quote:[[Topics/X.md]]' },
      kept: false,
    },
  ])(
    'checks authored YAML links, not feed/position values, when opening Feed: %j',
    async ({ properties }) => {
      const f = hostFixture(),
        file = await f.note('Reading/Stream/Article.md');
      const raw = await f.vault.process(file, (current) => patchProperties(current, properties));
      await f.view.openArticle(file.path);
      expect(file.path).toBe('Reading/Stream/Article.md');
      expect(await f.vault.read(file)).toBe(patchProperties(raw, { dog_ear: true }));
      expect((await f.store.read(file.path)).properties.status).toBe('feed');
    },
  );

  it('retains the Feed source and origin queue when annotation promotion fails', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Stream/A.md', 'before words after'),
      b = await f.note('Reading/Stream/B.md');
    f.view.showList('Feed');
    await enableHighlightHost(f);
    await f.view.openArticle(a.path, true);
    const raw = await f.vault.read(a);
    vi.spyOn(f.vault, 'process').mockRejectedValueOnce(new Error('Queue change failed'));
    f.probe.surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    await expect(f.probe.saveSelection()).rejects.toThrow('Queue change failed');
    expect(f.view.file).toBe(a);
    expect(a.path).toBe('Reading/Stream/A.md');
    expect(await f.vault.read(a)).toBe(raw);
    expect(f.probe.surface.displayedBody).toBe('before words after');
    expect(f.vault.trashed).toEqual([]);
    await f.view.navigate(1);
    expect(f.view.file).toBe(b);
  });
});

describe('commit-time annotation targets', () => {
  function readerPicker(f: ReturnType<typeof hostFixture>, target: TFile, wait = async () => {}) {
    const node: NodeResult = {
      path: target.path,
      title: 'Target',
      type: 'topic',
      classes: ['topic'],
      aliases: [],
    };
    const api: NodesApi = {
      version: 2,
      listTypes: () => [{ type: 'topic', label: 'Topic' }],
      searchNodes: () => [node],
      getNode: (path) => (path === target.path ? node : null),
      createNode: vi.fn(async () => null),
      createNodeForLink: vi.fn(async () => null),
      pickNodeForLink: vi.fn(async () => null),
    };
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    mocks.highlightPicker.mockImplementation(async () => {
      await wait();
      return { kind: 'existing', node };
    });
  }
  it('allows a position save while a link picker is open without losing the annotation', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', '==words=='),
      target = await f.note('Notes/Target.md', '', 'topic');
    await f.view.openArticle(article.path);
    const started = gate(),
      finish = gate();
    readerPicker(f, target, async () => {
      started.resolve();
      await finish.promise;
    });
    const linking = menu(f.view, 'Add highlight to notes…');
    await started.promise;
    f.probe.persistPosition('words');
    await f.probe.positionWrite;
    finish.resolve();
    await linking;
    expect((await f.store.read(article.path)).body).toBe(expectedHosted('==words==', target.path));
    expect((await f.store.read(article.path)).properties.bookmark).toBe('words');
  });

  it('rejects a selected note replaced at the same path after preflight validation', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', '==words=='),
      target = await f.note('Notes/Target.md', '', 'topic');
    await f.view.openArticle(article.path);
    readerPicker(f, target);
    const original = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
      f.vault.files.set(target.path, { path: target.path });
      return original(file, transform);
    });
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
      'typed destination changed',
    );
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
        listTypes: () => [{ type: 'topic', label: 'Topic' }],
        searchNodes: () => [node],
        getNode: () => node,
        createNode: async () => node,
        pickNodeForLink: vi.fn(async () => null),
      };
      let current: unknown = api;
      (f.app as any).plugins = { getPlugin: () => ({ api: current }) };
      mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node });
      await f.view.openArticle(article.path);
      const before = await f.vault.read(article),
        original = f.vault.process.bind(f.vault);
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
        if (kind === 'api') current = { ...api };
        else if (kind === 'classes') node.classes = ['person'];
        else if (kind === 'file') f.vault.files.delete(target.path);
        else f.vault.files.set(target.path, { path: target.path });
        return original(file, transform);
      });
      await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
        /Fileclass Inline changed|typed destination changed/,
      );
      expect(api.pickNodeForLink).not.toHaveBeenCalled();
      expect(await f.vault.read(article)).toBe(before);
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
      return path === 'Short topic name' || path === target.path ? target : null;
    });
    // The production NativeVault delegates native aliases to the metadata cache.
    Object.assign(f.vault, {
      resolveLink: (link: string, source: string) =>
        f.app.metadataCache.getFirstLinkpathDest(link, source) ?? undefined,
    });
    const api = enableTypedTopics(f);
    await f.view.openArticle(article.path);
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'existing-many',
      nodes: [api.getNode(target.path)!],
    });
    await f.probe.topics();
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      api,
      expect.objectContaining({ selectedPaths: [target.path] }),
    );
    expect((await f.store.read(article.path)).properties.topics).toEqual([
      '[[Short topic name|My label]]',
    ]);
  });

  it.each([
    { topics: ['unrecognized'] },
    { topics: ['[[Missing]]'] },
    { topics: [42] },
    { topics: 'not an array' },
  ])(
    'preserves unrecognized/unresolved topic data while adding a typed destination: $topics',
    async ({ topics }) => {
      const f = hostFixture(),
        article = await f.note('Reading/Inbox/A.md'),
        target = await f.note('Topics/Typed.md', 'Keep this target', 'topic');
      const original = createDocument({ type: 'article', status: 'inbox', topics }, 'body');
      f.vault.bytes.set(article, original);
      const api = enableTypedTopics(f),
        targetBefore = await f.vault.read(target);
      await f.view.openArticle(article.path);
      mocks.highlightPicker.mockImplementationOnce(async (_app, current, options) => {
        expect(current).toBe(api);
        expect(options.selectedPaths).toEqual([]);
        expect(api.searchNodes('')).toEqual([api.getNode(target.path)]);
        return { kind: 'existing-many', nodes: [api.getNode(target.path)!] };
      });
      await f.probe.topics();
      expect(mocks.highlightPicker).toHaveBeenCalledOnce();
      expect(api.getNode).toHaveBeenCalledWith(target.path);
      expect(await f.vault.read(article)).toBe(
        patchProperties(patchProperties(original, { dog_ear: true }), {
          topics: [...(Array.isArray(topics) ? topics : [topics]), '[[Topics/Typed.md]]'],
        }),
      );
      expect(await f.vault.read(target)).toBe(targetBefore);
    },
  );

  it('retains an article promoted before a link target disappears, without saving the stale link', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Stream/A.md', '==words=='),
      target = await f.note('Notes/Target.md', '', 'topic');
    await f.view.openArticle(article.path);
    readerPicker(f, target);
    // Lose the target only after retention is durably saved; preflight loss must not promote.
    f.probe.snapshot = await f.store.move(await f.store.read(article.path), 'Feed');
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (file, update) => {
      const raw = await process(file, update);
      f.vault.files.delete(target.path);
      return raw;
    });
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
      'typed destination changed',
    );
    expect(article.path).toBe('Reading/Stream/A.md');
    expect((await f.store.read(article.path)).properties.status).toBe('later');
    expect((await f.store.read(article.path)).body).toBe('==words==');
  });

  it('rechecks topic identity and type at commit time and keeps the rejected draft for Cancel', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md'),
      target = await f.note('Topics/One.md', '', 'topic');
    const api = enableTypedTopics(f);
    await f.view.openArticle(article.path);
    const before = await f.vault.read(article);
    let cancel: (() => void) | undefined;
    let draft: string[] = [];
    mocks.highlightPicker
      .mockResolvedValueOnce({ kind: 'existing-many', nodes: [api.getNode(target.path)!] })
      .mockImplementationOnce(async (_app, current, options) => {
        expect(current).toBe(api);
        draft = options.selectedPaths;
        return new Promise<null>((resolve) => {
          cancel = () => resolve(null);
        });
      });
    const original = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
      f.cache.set(target, { frontmatter: { type: 'person' } });
      return original(file, transform);
    });
    const pending = f.probe.topics();
    for (let i = 0; i < 100 && !cancel; i++) await Promise.resolve();
    expect(mocks.notice).toHaveBeenCalledWith(expect.stringContaining('typed destination changed'));
    expect(draft).toEqual([target.path]);
    expect(mocks.highlightPicker).toHaveBeenCalledTimes(2);
    expect(await f.vault.read(article)).toBe(before);
    expect(cancel).toBeDefined();
    cancel!();
    await pending;
    expect((await f.store.read(article.path)).properties.topics).toBeUndefined();
  });

  it('preserves rich words when unlinking a Markdown-linked highlight', async () => {
    const f = hostFixture(),
      article = await f.note(
        'Reading/Inbox/A.md',
        '==[**formatted words**](/Notes/URI%20Path.md)==',
      );
    await f.view.openArticle(article.path);
    await menu(f.view, 'Remove references (article only)');
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
      listTypes: vi.fn(() => [
        { type: 'topic', label: 'Topic' },
        { type: 'Other', label: 'Other' },
      ]),
      searchNodes: vi.fn(() => [node]),
      // Discovery's last-bound type legitimately differs from creation's chosen class.
      getNode: vi.fn((path) =>
        path === node.path ? { ...node, type: 'Other', classes: [...node.classes] } : null,
      ),
      createNode: vi.fn(async () => node),
      createNodeForLink: vi.fn(async (_options, link) => {
        await link(node);
        return node;
      }),
      pickNodeForLink: vi.fn(async () => null),
    };
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    mocks.highlightPicker.mockResolvedValue({ kind: 'create', title: 'words', type: 'topic' });
    await f.view.openArticle(article.path);
    return { ...f, article, target, node, api, linkedBody: expectedHosted(body, target.path) };
  }
  const linkedBody = expectedHosted('==words==', 'Nodes/One.md');
  const originalLinkedBody = '==[[Notes/Existing.md|words]]==';
  function expectedFiledTarget(f: Awaited<ReturnType<typeof fixture>>, before: string): string {
    const blockId = paragraphAnchors(f.linkedBody)[0].blockId;
    const citation = originLink(f.article.path, blockId, f.article.basename);
    return rememberOrigin(
      appendQuotation(before, 'words', citation).raw,
      originLink(f.article.path, blockId),
    );
  }
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
      if (route === 'footer' && label === 'Related notes')
        mocks.highlightPicker.mockResolvedValueOnce(null); // Explicitly Cancel the separate related-note draft.
      if (route === 'footer' || (route === 'link' && !['heading', 'unsafe'].includes(label))) {
        const signal = f.probe.nodeCreation?.controller.signal as AbortSignal | undefined;
        // Normal article navigation is intentionally replaced by the passage bar.
        // Done must cancel synchronously, before any queued navigation can wait on Nodes.
        passageButton(f.view, 'Done').click();
        if (signal) expect(signal.aborted).toBe(true);
        expect(f.view.contentEl.querySelector('[aria-label="Done"]')).toBeNull();
      }
      if (route === 'footer' && ['Read later', 'Archive'].includes(label))
        mocks.choose.mockResolvedValueOnce(label === 'Read later' ? 'Later' : 'Archive');
      if (route === 'command') {
        const id = { 'Move…': 'move', 'Topics…': 'topics', 'Open Markdown': 'open-markdown' }[
          label
        ];
        const command = mocks.commands.get(id!);
        expect(command?.checkCallback?.(true)).toBe(true);
        if (id === 'topics') mocks.highlightPicker.mockResolvedValueOnce(null); // Cancel the new staged Related notes dialog, not the uncooperative provider.
        expect(command?.checkCallback?.(false)).toBe(true);
      } else if (route === 'menu') {
        // Legacy route name; actions now use the existing passage bar, not a popup.
        passageButton(f.view, label).click();
        expectNoPassagePopup();
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
          (button) =>
            actionName(button) ===
            (['Read later', 'Archive'].includes(label) ? 'Change status' : label),
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
    'shows the approved icon-only passage bar (linked=$linked, Nodes=$integrated)',
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
        expect(passageLabels(f.view)).toEqual(
          expectedPassageActions({ linked, provider: integrated }),
        );
        expect(
          [...f.view.contentEl.querySelectorAll<HTMLButtonElement>('[data-action]')].map(
            (button) => button.dataset.action,
          ),
        ).toEqual([
          ...(linked ? ['open-note'] : []),
          'link-note',
          'convert-node',
          ...(linked ? ['unlink'] : []),
          'remove-highlight',
        ]);
        for (const button of f.view.contentEl.querySelectorAll('.reader-actions button')) {
          expect(button.textContent).toBe('');
          expect(button.querySelector('svg')).not.toBeNull();
        }
        expectNoPassagePopup();
      } finally {
        f.view.stopForUnload();
      }
    },
  );

  it.each([
    { linked: false, intent: 'existing' },
    { linked: true, intent: 'existing' },
    { linked: false, intent: 'create' },
  ] as const)(
    'uses the Reader multiselect for linked=$linked / $intent, never the shared provider picker',
    async ({ linked, intent }) => {
      const f = await fixture(linked ? originalLinkedBody : '==words==');
      if (intent === 'existing')
        mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.node });
      else
        mocks.highlightPicker.mockResolvedValue({
          kind: 'create',
          title: 'Typed topic',
          type: 'topic',
        });
      await menu(f.view, 'Add highlight to notes…');
      expect(mocks.highlightPicker).toHaveBeenCalledWith(
        f.app,
        f.api,
        expect.objectContaining({
          query: '',
          signal: expect.any(AbortSignal),
          title: 'Add highlight to notes',
          multiple: true,
          minSelection: 0,
          actionLabel: 'Apply',
        }),
      );
      if (intent === 'create')
        expect(f.api.createNodeForLink).toHaveBeenCalledWith(
          {
            type: 'topic',
            suggestedTitle: 'Typed topic',
            sourcePath: f.article.path,
            signal: expect.any(AbortSignal),
          },
          expect.any(Function),
        );
      else expect(f.api.createNodeForLink).not.toHaveBeenCalled();
      expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
      expect(mocks.choose).not.toHaveBeenCalled();
      expect(f.api.createNode).not.toHaveBeenCalled();
      const body = (await f.store.read(f.article.path)).body;
      expect(body).toBe(linked ? expectedHosted(originalLinkedBody, f.target.path) : linkedBody);
      if (linked) {
        expect(body).toContain('==[[Notes/Existing.md|words]]=='); // Preserve the authored URL; it is not an extra host.
        expect(passages(body)[0].hosts).toEqual(['Nodes/One']);
      }
    },
  );

  it.each(['picker', 'creation'] as const)(
    'cancels the Reader %s flow without a write',
    async (stage) => {
      const f = await fixture(),
        before = await f.vault.read(f.article),
        targetBefore = await f.vault.read(f.target);
      if (stage === 'picker') mocks.highlightPicker.mockResolvedValue(null);
      else f.api.createNodeForLink = vi.fn(async () => null);
      await menu(f.view, 'Add highlight to notes…');
      expect(await f.vault.read(f.article)).toBe(before);
      expect(await f.vault.read(f.target)).toBe(targetBefore);
      expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
      expect(f.vault.trashed).toEqual([]);
      expect(f.probe.dialog).toBe(false);
    },
  );

  it('preserves stale-source checks across Reader choice and the typed creation callback', async () => {
    const f = await fixture(),
      changed = createDocument({ type: 'article' }, '==new words==');
    f.api.createNodeForLink = async (_options, link) => {
      f.vault.bytes.set(f.article, changed);
      await link(f.node);
      return f.node;
    };
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow();
    expect(await f.vault.read(f.article)).toBe(changed);
    expect(f.vault.trashed).toEqual([]);
  });

  it.each(['Remove references (article only)', 'Remove highlight (article only)'])(
    'never removes or rewrites the linked file through %s',
    async (label) => {
      const f = await fixture(linkedBody),
        targetBefore = await f.vault.read(f.target);
      await menu(f.view, label);
      expect((await f.store.read(f.article.path)).body).toBe(
        `${label === 'Remove highlight (article only)' ? 'words' : '==words=='} ^${paragraphAnchors(linkedBody)[0].blockId}`,
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
      mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.node });
      await menu(f.view, 'Add highlight to notes…');
      expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
    },
  );

  it.each(['Inbox', 'Feed'] as const)(
    'commits directly before required completion without self-cancellation or a second link (%s)',
    async (queue) => {
      const f = await fixture(),
        entered = gate(),
        complete = gate(),
        order: string[] = [];
      if (queue === 'Feed')
        f.probe.snapshot = await f.store.move(await f.store.read(f.article.path), 'Feed');
      const annotate = vi.spyOn(f.store, 'collectHighlight'),
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
      const creation = menu(f.view, 'Add highlight to notes…');
      await entered.promise;
      expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
      expect(order).toEqual(['created', 'linked']);
      expect(f.probe.dialog).toBe(true);
      expect(f.probe.surface.displayedBody).toBe(f.linkedBody);
      await f.view.changed({ path: f.article.path, metadataChanged: true });
      f.probe.persistPosition('words');
      await f.probe.positionWrite; // Must not wait for itself through the metadata notification.
      expect(requestSignal.aborted).toBe(false);
      expect((await f.store.read(f.article.path)).properties.bookmark).toBe('words');
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
      const creation = menu(f.view, 'Add highlight to notes…');
      await linked.promise;
      expect(requestSignal.aborted).toBe(false);
      const oldPath = f.article.path;
      if (kind === 'body')
        f.vault.bytes.set(f.article, createDocument({ type: 'article' }, 'External edit'));
      if (kind === 'type')
        f.vault.bytes.set(f.article, createDocument({ type: 'note' }, f.linkedBody));
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
    const creation = menu(f.view, 'Add highlight to notes…');
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
      f.api.createNodeForLink = async (options, link) => {
        requestSignal = options.signal!;
        requestSignal.addEventListener('abort', () => stopped.resolve(), { once: true });
        if (phase === 'after') await link(f.node);
        linked.resolve();
        await stopped.promise;
        return null;
      };
      const creation = menu(f.view, 'Add highlight to notes…');
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
        phase === 'after' ? f.linkedBody : '==words==',
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
      const annotate = vi.spyOn(f.store, 'collectHighlight');
      let requestSignal!: AbortSignal;
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        requestSignal = options.signal!;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        await providerRelease.promise; // Deliberately ignores the signal.
        await expect(link(f.node)).rejects.toThrow('request has finished');
        return f.node;
      });
      const creation = menu(f.view, 'Add highlight to notes…');
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
      await vi.mocked(f.api.createNodeForLink).mock.results[0].value;
      expect(annotate).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0);
      expect((await f.store.read(f.article.path)).body).toBe(
        phase === 'after' ? f.linkedBody : '==words==',
      );
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(f.vault.trashed).toEqual([]);
    },
    1500,
  );

  it.each(['before', 'after'])(
    'Done synchronously cancels a never-settling picker %s commit and restores article controls',
    async (phase) => {
      const f = await uiFixture(),
        entered = gate(),
        targetBefore = await f.vault.read(f.target);
      const annotate = vi.spyOn(f.store, 'collectHighlight');
      let requestSignal!: AbortSignal, late!: (node: NodeResult) => Promise<void>;
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        requestSignal = options.signal!;
        late = link;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        return new Promise<NodeResult | null>(() => {}); // Never settles, even after abort.
      });
      try {
        const creation = menu(f.view, 'Add highlight to notes…');
        await entered.promise;
        const targetExpected =
          phase === 'after' ? expectedFiledTarget(f, targetBefore) : targetBefore;
        passageButton(f.view, 'Done').click();
        expect(requestSignal.aborted).toBe(true); // No queue or microtask may precede abort.
        expect(f.probe.tapMode).toBe(false);
        expect(f.view.contentEl.querySelector('[aria-label="Done"]')).toBeNull();
        expect(
          passageLabels(f.view).some((label) => label.startsWith('Change status and advance')),
        ).toBe(true);
        await creation;
        await f.probe.operations;
        await expect(late(f.node)).rejects.toThrow('request has finished');
        expect(f.probe.dialog).toBe(false);
        expect(annotate).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0);
        expect((await f.store.read(f.article.path)).body).toBe(
          phase === 'after' ? f.linkedBody : originalLinkedBody,
        );
        expect(await f.vault.read(f.target)).toBe(targetExpected);
        expect(f.vault.trashed).toEqual([]);
        expectNoPassagePopup();
      } finally {
        f.view.stopForUnload();
      }
    },
    1500,
  );

  it.each(
    ['before', 'after'].flatMap((phase) =>
      [
        'Add highlight to notes…',
        'Add highlight to notes…',
        'Remove references (article only)',
        'Remove highlight (article only)',
      ].map((label) => ({ phase, label })),
    ),
  )(
    'supersedes a never-settling picker through the actual $label passage button $phase commit',
    async ({ phase, label }) => {
      const f = await uiFixture(),
        entered = gate(),
        targetBefore = await f.vault.read(f.target);
      const collect = vi.spyOn(f.store, 'collectHighlight'),
        annotate = vi.spyOn(f.store, 'annotate');
      let requestSignal!: AbortSignal,
        late!: (node: NodeResult) => Promise<void>,
        calls = 0;
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        if (++calls > 1) return null;
        requestSignal = options.signal!;
        late = link;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        return new Promise<NodeResult | null>(() => {});
      });
      try {
        const creation = menu(f.view, 'Add highlight to notes…');
        await entered.promise;
        const targetExpected =
          phase === 'after' ? expectedFiledTarget(f, targetBefore) : targetBefore;
        const superseding = f.click('menu', label);
        expect(requestSignal.aborted).toBe(true);
        await superseding;
        await creation;
        await f.probe.operations;
        await expect(late(f.node)).rejects.toThrow('request has finished');
        const changesPassage = [
          'Remove references (article only)',
          'Remove highlight (article only)',
        ].includes(label);
        expect(collect).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0);
        expect(annotate).toHaveBeenCalledTimes(changesPassage ? 1 : 0);

        expect(calls).toBe(changesPassage ? 1 : 2);
        const expectedSource = phase === 'after' ? f.linkedBody : originalLinkedBody;
        expect((await f.store.read(f.article.path)).body).toBe(
          changesPassage
            ? changePassage(
                expectedSource,
                passages(expectedSource)[0],
                label === 'Remove highlight (article only)' ? 'remove' : 'unlink',
              )
            : expectedSource,
        );

        expect(f.probe.dialog).toBe(false);
        expect(await f.vault.read(f.target)).toBe(targetExpected);
        expect(f.vault.trashed).toEqual([]);
        expectNoPassagePopup();
      } finally {
        f.view.stopForUnload();
      }
    },
    1500,
  );

  it.each(
    ['before', 'after'].flatMap((phase) =>
      [
        ['footer', 'Read later'],
        ['footer', 'Archive'],
        ['footer', 'Delete'],
        ['footer', 'List'],
        ['command', 'Move…'],
        ['command', 'Topics…'],
        ['command', 'Open Markdown'],
        ['link', 'internal'],
        ['link', 'new-leaf'],
        ['link', 'external'],
        ['menu', 'Open note'],
        ['menu', 'Add highlight to notes…'],
        ['menu', 'Add highlight to notes…'],
        ['menu', 'Remove references (article only)'],
        ['menu', 'Remove highlight (article only)'],
      ].map(([route, label]) => ({ phase, route, label })),
    ),
  )(
    'cancels via actual $route / $label UI $phase commit, without waiting for the provider',
    async ({ phase, route, label }) => {
      const f = await uiFixture(),
        entered = gate(),
        providerRelease = gate();
      const collect = vi.spyOn(f.store, 'collectHighlight'),
        annotate = vi.spyOn(f.store, 'annotate'),
        targetBytes = await f.vault.read(f.target);
      const sourcePath = f.article.path;
      const neighbour = f.probe.readingQueue.neighbour(label === 'Previous' ? -1 : 1, () => true);
      let requestSignal!: AbortSignal,
        calls = 0;
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        if (++calls > 1) return null; // A second explicit Create node action is cancelled at its picker.
        requestSignal = options.signal!;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        await providerRelease.promise; // Ignores cancellation deliberately.
        await expect(link(f.node)).rejects.toThrow('request has finished');
        return f.node;
      });
      try {
        const creation = menu(f.view, 'Add highlight to notes…');
        await entered.promise;
        const targetExpected =
          phase === 'after' ? expectedFiledTarget(f, targetBytes) : targetBytes;
        const intent = f.click(route, label);
        expect(requestSignal.aborted).toBe(true); // Even before the next microtask.
        await intent;
        await creation;
        await f.probe.operations;
        // Reach the destination before releasing the uncooperative provider.
        if (['Next', 'Previous', 'Archive', 'Read later', 'Delete'].includes(label))
          expect(f.view.file?.path).toBe(neighbour);
        if (label === 'Read later') {
          expect(f.article.path).toBe('Reading/Later/A.md');
          expect((await f.store.read(f.article.path)).properties.status).toBe('later');
          expect(mocks.choose).toHaveBeenCalledWith(
            f.app,
            'Change article status…',
            ['Inbox', 'Later', 'Feed', 'Archive'],
            expect.any(Function),
            expect.any(AbortSignal),
          );
          expect(f.api.createNodeForLink).toHaveBeenCalledTimes(1);
        }
        if (label === 'List') expect(f.view.file).toBeUndefined();
        if (label === 'Move…') expect(mocks.choose).toHaveBeenCalled();
        if (label === 'Topics…')
          expect(mocks.highlightPicker).toHaveBeenCalledWith(
            f.app,
            f.api,
            expect.objectContaining({ title: 'Related notes', multiple: true }),
          );
        if (label === 'Add highlight to notes…')
          expect(f.api.createNodeForLink).toHaveBeenCalledTimes(2);
        if (label === 'Add highlight to notes…') expect(calls).toBe(2);
        if (label === 'Archive') {
          expect(f.article.path).toBe('Reading/Treasury/A.md');
          expect((await f.store.read(f.article.path)).properties.status).toBe('archive');
        }
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
        await vi.mocked(f.api.createNodeForLink).mock.results[0].value;
        const changesPassage = [
          'Remove references (article only)',
          'Remove highlight (article only)',
        ].includes(label);
        expect(collect).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0);
        expect(annotate).toHaveBeenCalledTimes(changesPassage ? 1 : 0);

        const expectedSource = phase === 'after' ? f.linkedBody : originalLinkedBody;
        expect((await f.store.read(f.article.path)).body).toBe(
          changesPassage
            ? changePassage(
                expectedSource,
                passages(expectedSource)[0],
                label === 'Remove highlight (article only)' ? 'remove' : 'unlink',
              )
            : expectedSource,
        );

        expect(f.vault.trashed).toEqual([]);
        if (label === 'Delete') {
          expect(f.article.path).toBe('Reading/Treasury/A.md');
          expect((await f.store.read(f.article.path)).properties.status).toBe('archive');
        }
        expect(f.vault.file(f.target.path)).toBe(f.target);
        expect(await f.vault.read(f.target)).toBe(targetExpected);
        expect(f.api.createNode).not.toHaveBeenCalled();
      } finally {
        providerRelease.resolve();
        f.view.stopForUnload();
      }
    },
    1500,
  );

  it.each([
    ['footer', 'List'],
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
      f.api.createNodeForLink = async (options, link) => {
        requestSignal = options.signal!;
        await link(f.node);
        return f.node;
      };
      try {
        const creation = menu(f.view, 'Add highlight to notes…');
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
        expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
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
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        requestSignal = options.signal!;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        await providerRelease.promise;
        await expect(link(f.node)).rejects.toThrow('request has finished');
        return f.node;
      });
      try {
        const creation = menu(f.view, 'Add highlight to notes…');
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
        await vi.mocked(f.api.createNodeForLink).mock.results[0].value;
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
    ['footer', 'List'],
    ['link', 'internal'],
    ['command', 'Open Markdown'],
    ['menu', 'Remove highlight (article only)'],
  ])(
    'invalidates queued Nodes creation at the actual %s / %s UI intent',
    async (route, label) => {
      const f = await uiFixture(),
        entered = gate(),
        release = gate();
      f.api.createNodeForLink = vi.fn(async () => f.node);
      try {
        const busy = f.probe.operation(async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        const creation = menu(f.view, 'Add highlight to notes…');
        await f.click(route, label);
        release.resolve();
        await busy;
        await creation;
        await f.probe.operations;
        expect(f.api.createNodeForLink).not.toHaveBeenCalled();
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

  it('keeps required completion live for scrolling, blocked link/keyboard navigation and background flush', async () => {
    const f = await uiFixture(),
      entered = gate(),
      complete = gate();
    let requestSignal!: AbortSignal;
    f.api.createNodeForLink = async (options, link) => {
      requestSignal = options.signal!;
      await link(f.node);
      entered.resolve();
      await complete.promise;
      return f.node;
    };
    try {
      const creation = menu(f.view, 'Add highlight to notes…');
      await entered.promise;
      // Palette availability checks and in-article scrolling do not cancel completion.
      for (const id of ['move', 'topics', 'open-markdown'])
        expect(mocks.commands.get(id)?.checkCallback?.(true)).toBe(true);
      expect(f.view.contentEl.querySelector('[aria-label="Next page"]')).toBeNull();
      f.probe.surface.viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      const heading = document.createElement('h2');
      heading.id = 'section';
      f.probe.surface.body.append(heading);
      await f.click('link', 'heading');
      await f.click('link', 'unsafe');
      f.view.key(new KeyboardEvent('keydown', { key: 'j' }));
      expect(f.probe.surface.page).not.toHaveBeenCalled();
      expect(f.probe.surface.reveal).not.toHaveBeenCalled();
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
    f.api.createNodeForLink = vi.fn(async () => f.node);
    const busy = f.probe.operation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const creation = menu(f.view, 'Add highlight to notes…'),
      navigation = f.view.readingList();
    release.resolve();
    await busy;
    await creation;
    await navigation;
    expect(f.api.createNodeForLink).not.toHaveBeenCalled();
    expect(f.api.createNode).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe('==words==');
    expect(f.vault.trashed).toEqual([]);
  });

  it.each(['null', 'cancel', 'reject'] as const)(
    'retains both committed link and target after completion %s',
    async (kind) => {
      const f = await fixture(),
        annotate = vi.spyOn(f.store, 'collectHighlight');
      const rejection = { reason: 'completion failed' },
        targetBytes = await f.vault.read(f.target);
      f.api.createNodeForLink = async (_options, link) => {
        await link(f.node);
        if (kind === 'cancel') f.probe.articleLifetime.abort();
        if (kind === 'reject') throw rejection;
        return null;
      };
      const creation = menu(f.view, 'Add highlight to notes…');
      if (kind === 'reject') await expect(creation).rejects.toBe(rejection);
      else await creation;
      expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
      expect(annotate).toHaveBeenCalledOnce();
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect(await f.vault.read(f.target)).toBe(expectedFiledTarget(f, targetBytes));
      expect(f.vault.trashed).toEqual([]);
    },
  );

  it.each(['null', 'identity'] as const)(
    'does not link from a %s return or accept a callback after the request settles',
    async (result) => {
      const f = await fixture(),
        annotate = vi.spyOn(f.store, 'collectHighlight');
      let late!: (node: NodeResult) => Promise<void>;
      f.api.createNodeForLink = async (_options, link) => {
        late = link;
        return result === 'null' ? null : f.node;
      };
      await menu(f.view, 'Add highlight to notes…');
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
    const creation = menu(f.view, 'Add highlight to notes…');
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
      annotate = vi.spyOn(f.store, 'collectHighlight');
    f.api.createNodeForLink = async (_options, link) => {
      await link(f.node);
      await link(f.node);
      return f.node;
    };
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow('callback already ran');
    expect(annotate).toHaveBeenCalledOnce();
    expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
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
      await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow();
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
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
      /source annotation was saved.*quotation was not filed/,
    );
    expect(completion).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
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
    const creation = menu(f.view, 'Add highlight to notes…');
    await entered.promise;
    f.probe.persistPosition('words');
    await f.probe.positionWrite;
    complete.resolve();
    await creation;
    expect((await f.store.read(f.article.path)).properties.bookmark).toBe('words');
    expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
  });

  it.each(['missing', 'old', 'standalone', 'legacy-id'] as const)(
    'keeps legacy actions safe and reports unsupported hosted creation (%s)',
    async (mode) => {
      const original = '==legacy== and new words',
        f = await fixture(original);
      if (mode === 'missing') (f.app as any).plugins = undefined;
      else if (mode === 'old') (f.api as any).version = 1;
      else if (mode === 'standalone') delete f.api.createNodeForLink;
      else
        (f.app as any).plugins = {
          getPlugin: (id: string) => (id === 'obsidian-nodes' ? { api: f.api } : undefined),
        };
      await f.view.onOpen();
      await f.view.openArticle(f.article.path, true);
      const targetBefore = await f.vault.read(f.target);
      let expected = original,
        targetExpected = targetBefore;
      if (mode === 'standalone') {
        // Linked creation is optional for choosing an existing typed destination.
        mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.node });
        await menu(f.view, 'Add highlight to notes…');
        expected = expectedHosted(original, f.target.path);
        const blockId = paragraphAnchors(expected)[0].blockId;
        targetExpected = appendQuotation(
          targetBefore,
          'legacy',
          originLink(f.article.path, blockId, f.article.basename),
        ).raw;
        expect((await f.store.read(f.article.path)).body).toBe(expected);
        expect(await f.vault.read(f.target)).toBe(targetExpected);
        mocks.highlightPicker.mockResolvedValue({ kind: 'create', title: 'legacy', type: 'topic' });
        await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
          'createNodeForLink support',
        );
      } else {
        f.probe.surface.selectionValue = { quote: 'new words', before: 'legacy and ', after: '' };
        await expect(f.probe.saveSelection()).rejects.toThrow(/Fileclass Inline.*v2/);
        f.probe.surface.selectionValue = undefined;
        expect((await f.store.read(f.article.path)).body).toBe(original);
        expect(mocks.highlightPicker).not.toHaveBeenCalled();
      }
      expect((await f.store.read(f.article.path)).body).toBe(expected);
      f.probe.surface.body.innerHTML = '<mark>legacy</mark> and new words';
      f.probe.surface.body
        .querySelector('mark')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(passageLabels(f.view)).toEqual(
        expectedPassageActions({ linked: mode === 'standalone', provider: mode === 'standalone' }),
      );
      expectNoPassagePopup();
      await menu(f.view, 'Remove highlight (article only)');
      expect((await f.store.read(f.article.path)).body).toBe(
        changePassage(expected, passages(expected)[0], 'remove'),
      );
      expect(await f.vault.read(f.target)).toBe(targetExpected);
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
      expect(f.vault.trashed).toEqual([]);
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
    const article = await f.note(`${folders.articles}/Current.md`);
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
    expect(captured.status).toBe('inbox');
    expect(f.host.ingestion.acquire).toHaveBeenLastCalledWith(captured.path, true);
    expect(f.view.file).toBe(f.article);
    expect(f.probe.surface).toBe(surface);
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });
  it.each(['inbox', 'feed', 'later', 'archive', undefined, 'invalid', null] as const)(
    'preserves duplicate status, bookmark, placement and authored bytes: %s',
    async (status) => {
      const folders = {
        articles: 'Capture',
        feeds: 'Subscriptions',
      };
      const f = await fixture('https://publisher.test/story', folders);
      const existing = await f.note('Unrelated/Existing.md');
      const raw = createDocument(
        {
          type: 'article',
          url: 'https://publisher.test/story',
          status,
          bookmark: 'authored words',
          custom: 'Preserve',
        },
        'authored ==words==',
      );
      f.vault.bytes.set(existing, raw);
      f.store.catalog.update(existing.path, readDocument(raw).properties);
      const move = vi.spyOn(f.store, 'move');
      await f.save(new AbortController().signal);
      expect(f.vault.files.size).toBe(2);
      expect(existing.path).toBe('Unrelated/Existing.md');
      expect(await f.vault.read(existing)).toBe(raw);
      const saved = await f.store.read(existing.path);
      expect(saved.properties.status).toBe(status);
      expect(Object.hasOwn(saved.properties, 'status')).toBe(status !== undefined);
      expect(saved.properties.bookmark).toBe('authored words');
      expect(saved.body).toBe('authored ==words==');
      expect(move).not.toHaveBeenCalled();
      expect(f.host.ingestion.acquire).toHaveBeenLastCalledWith(existing.path, true);
      expect(f.view.file).toBe(f.article);
    },
  );
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
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ provider: false }));
    expectNoPassagePopup();
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
  it('preserves a duplicate and skips acquisition when navigation cancels pending capture', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate();
    const existing = await f.store.capture({
      url: 'https://publisher.test/story',
      queue: 'Feed',
      body: 'Keep authored text',
    });
    const path = existing.path,
      raw = await f.vault.read(existing);
    const capture = f.store.capture.bind(f.store);
    vi.spyOn(f.store, 'capture').mockImplementationOnce(async (...args) => {
      const file = await capture(...args);
      entered.resolve();
      await release.promise;
      return file;
    });
    f.host.ingestion.acquire.mockClear();
    const save = f.save(new AbortController().signal).catch((error) => error);
    await entered.promise;
    await f.view.readingList();
    release.resolve();
    expect(await save).toMatchObject({ message: 'Reader capture was cancelled.' });
    expect(existing.path).toBe(path);
    expect(await f.vault.read(existing)).toBe(raw);
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
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
      { feed: '[[Reading/Wires/Feed.md]]', bookmark: 'quote:[[Topics/X.md]]' },
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
    for (const file of candidates) {
      expect(file.path).toContain('/Later/');
      expect((await f.store.read(file.path)).properties.status).toBe('later');
    }
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
        'bookmark',
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
      expect(file.path).toBe(stale ? 'Reading/Stream/Article.md' : 'Reading/Later/Article.md');
      expect(await f.vault.read(file)).toBe(
        stale ? before : patchProperties(before, { status: 'later' }),
      );
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

describe('hosted highlight UI integration', () => {
  const views: ReaderView[] = [],
    renders: (() => void)[] = [];
  afterEach(() => {
    renders.splice(0).forEach((dispose) => dispose());
    views.splice(0).forEach((view) => view.stopForUnload());
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    vi.unstubAllGlobals();
  });
  async function fixture(options: { body?: string; defaults?: number[] } = {}) {
    const f = hostFixture();
    views.push(f.view);
    const article = await f.note(
      'Reading/Inbox/Hosted.md',
      options.body ?? 'Before first words after.',
    );
    const targets = [
      await f.note('Nodes/Concept.md', 'Authored concept.', 'concept'),
      await f.note('Nodes/Project.md', 'Authored project.', 'project'),
    ];
    const nodes: NodeResult[] = targets.map((file, index) => ({
      path: file.path,
      title: index ? 'Project' : 'Concept',
      type: 'different-primary-type',
      classes: index ? ['Other', 'Project'] : ['Other', 'Concept'],
      aliases: [],
    }));
    const api = {
      version: 2 as const,
      listTypes: vi.fn(() => [
        { type: 'Concept', label: 'Concept' },
        { type: 'Project', label: 'Project' },
      ]),
      searchNodes: vi.fn(() => nodes),
      getNode: vi.fn((path: string) => nodes.find((node) => node.path === path) ?? null),
      createNode: vi.fn(async () => null),
      pickNodeForLink: vi.fn(async () => null),
      createNodeForLink: vi.fn<NonNullable<NodesApi['createNodeForLink']>>(async () => null),
    } satisfies NodesApi;
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    if (options.defaults)
      f.vault.bytes.set(
        article,
        patchProperties(await f.vault.read(article), {
          topics: options.defaults.map((index) => `[[${nodes[index].path.replace(/\.md$/, '')}]]`),
        }),
      );
    await f.view.onOpen();
    await f.view.openArticle(article.path);
    const select = (quote = 'first words', before = 'Before ', after = ' after.') => {
      f.probe.surface.selectionValue = { quote, before, after };
      return f.probe.saveSelection() as Promise<void>;
    };
    const paint = () =>
      renders.push(
        renderBody(
          f.probe.snapshot.body,
          f.probe.surface.body,
          'https://publisher.test',
          (path, element) => f.probe.paintReferenceIcon(path, element, article),
        ),
      );
    return { ...f, article, targets, nodes, api, select, paint };
  }
  function nativeClicks(f: Awaited<ReturnType<typeof fixture>>) {
    const root = f.probe.surface.body as HTMLElement;
    let hit: Element = root;
    const nativeRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = nativeRange();
      range.getClientRects = () => [new DOMRect(0, 0, 400, 40)] as unknown as DOMRectList;
      range.getBoundingClientRect = () => new DOMRect(0, 0, 400, 40);
      return range;
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 40));
    const descriptors = ['elementFromPoint', 'caretRangeFromPoint'].map(
      (key) => [key, Object.getOwnPropertyDescriptor(document, key)] as const,
    );
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => {
        const walker = document.createTreeWalker(hit, NodeFilter.SHOW_TEXT),
          text = walker.nextNode();
        if (!text) return null;
        const range = document.createRange();
        range.setStart(text, 0);
        range.collapse(true);
        return range;
      },
    });
    renders.push(() =>
      descriptors.forEach(([key, descriptor]) => {
        if (descriptor) Object.defineProperty(document, key, descriptor);
        else delete (document as unknown as Record<string, unknown>)[key];
      }),
    );
    return (element: Element, init: MouseEventInit = {}) => {
      hit = element;
      for (const type of ['pointerdown', 'pointerup']) {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
          ...init,
        });
        Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true });
        element.dispatchEvent(event);
      }
      element.dispatchEvent(
        new MouseEvent(init.button === 1 ? 'auxclick' : 'click', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
          ...init,
        }),
      );
    };
  }
  async function initialPartialCollection(mode: 'native selection' | 'tap') {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(2026, 9, 20, 12));
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
    const f = await fixture({ body: 'first words' });
    f.store.setStatusFolders({ feed: 'Reading/Stream', later: 'Reading/Later' });
    await f.vault.move(f.article, 'Reading/Stream/Hosted.md');
    f.vault.bytes.set(
      f.article,
      patchProperties(await f.vault.read(f.article), { status: 'feed' }),
    );
    f.probe.adoptSnapshot(await f.store.read(f.article.path));
    const process = f.vault.process.bind(f.vault),
      calls: string[] = [];
    let created!: TFile,
      failed = false;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      calls.push(file.path);
      if (file === created && !failed) {
        failed = true;
        throw new Error('Created destination failed before its process applied');
      }
      return process(file, update);
    });
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'create',
      title: 'Created',
      type: 'Project',
      existingNodes: [f.nodes[0]],
    });
    f.api.createNodeForLink.mockImplementationOnce(async (_options, link) => {
      created = await f.note('Nodes/Created.md', 'Authored created note.', 'project');
      const node = {
        ...f.nodes[1],
        path: created.path,
        title: 'Created',
        classes: ['Concept', 'Project'],
      };
      f.nodes.push(node);
      await link(node);
      return node;
    });
    const click = nativeClicks(f),
      root = f.probe.surface.body as HTMLElement;
    const save = vi.spyOn(f.probe, mode === 'tap' ? 'saveTapSelection' : 'saveSelection');
    if (mode === 'tap') {
      (
        f.view.contentEl.querySelector('.reader-tap-highlight-trigger') as HTMLButtonElement
      ).click();
      click(root.querySelector('p')!);
      passageButton(f.view, 'Paragraph').click();
    } else {
      const range = document.createRange();
      range.selectNodeContents(root.querySelector('p')!);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await expect(f.probe.operations).rejects.toThrow(/source annotation was saved/i);
    await f.probe.positionWrite;
    expect(save).toHaveBeenCalledOnce();
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ query: '' }),
    );
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
    expect(f.api.createNodeForLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Project', suggestedTitle: 'Created' }),
      expect.any(Function),
    );
    expect(f.api.createNode).not.toHaveBeenCalled();
    expect(f.article.path).toBe('Reading/Later/Hosted.md');
    const source = await f.store.read(f.article.path),
      first = await f.vault.read(f.targets[0]),
      pending = await f.vault.read(created);
    expect(passages(source.body)[0].hosts).toEqual(['Nodes/Concept', 'Nodes/Created']);
    expect(first).toContain('[[2026-10-20]]');
    expect(pending).not.toContain('## Highlights');
    expect(readDocument(pending).properties.origin).toBeUndefined();
    const retry = passageButton(f.view, 'Retry note updates');
    expect(retry.isConnected).toBe(true);
    return { ...f, created, source, first, pending, calls, retry };
  }
  it.each(['native selection', 'tap'] as const)(
    'retries only the unfinished created destination after initial %s filing fails',
    async (mode) => {
      const f = await initialPartialCollection(mode),
        before = f.calls.length;
      vi.setSystemTime(new Date(2026, 9, 21, 12));
      f.retry.click();
      await f.probe.operations;
      expect(f.calls.slice(before)).toEqual([f.created.path]);
      expect(await f.vault.read(f.article)).toBe(f.source.raw);
      expect(await f.vault.read(f.targets[0])).toBe(f.first);
      const filed = await f.vault.read(f.created),
        block = paragraphAnchors(f.source.body)[0].blockId;
      expect(filed).toContain(
        `> first words (※ ${originLink(f.source.path, block, 'Hosted')} [[2026-10-21]])`,
      );
      expect(readDocument(filed).properties.origin).toBe(originLink(f.source.path, block));
      expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
      expect(f.vault.trashed).toEqual([]);
    },
  );
  it.each(
    (['native selection', 'tap'] as const).flatMap((mode) =>
      (['provider', 'target identity', 'requested class', 'source bytes'] as const).map(
        (change) => ({ mode, change }),
      ),
    ),
  )(
    'revalidates original $change authority before retrying initial $mode collection',
    async ({ mode, change }) => {
      const f = await initialPartialCollection(mode),
        before = f.calls.length;
      let expectedSource = f.source.raw,
        target = f.created;
      if (change === 'provider')
        (f.app as any).plugins = { getPlugin: () => ({ api: { ...f.api } }) };
      else if (change === 'target identity') {
        f.vault.files.delete(f.created.path);
        target = await f.note(f.created.path, 'Replacement must stay untouched.', 'project');
      } else if (change === 'requested class')
        f.nodes.find((node) => node.path === f.created.path)!.classes = ['Concept'];
      else {
        expectedSource += '\nForeign source edit.';
        f.vault.bytes.set(f.article, expectedSource);
      }
      const targetBytes = await f.vault.read(target);
      f.retry.click();
      await f.probe.operations.catch(() => {});
      expect(f.calls.slice(before)).toEqual([]);
      expect(await f.vault.read(f.article)).toBe(expectedSource);
      expect(await f.vault.read(f.targets[0])).toBe(f.first);
      expect(await f.vault.read(target)).toBe(targetBytes);
      expect(readDocument(targetBytes).properties.origin).toBeUndefined();
      expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
      expect(f.vault.trashed).toEqual([]);
    },
  );
  it('keeps a failed explicit mention origin-only and never offers the quotation retry action', async () => {
    const initial = hostSelection('first words', { quote: 'first words' }, ['Nodes/Concept.md']);
    const f = await fixture({ body: initial.body });
    const first = await f.vault.read(f.targets[0]),
      process = f.vault.process.bind(f.vault);
    let created!: TFile, planned: string | undefined;
    f.api.createNodeForLink.mockImplementationOnce(async (_options, link) => {
      created = await f.note('Nodes/Created mention.md', 'Authored mention note.', 'project');
      const node = { ...f.nodes[1], path: created.path, title: 'Created mention' };
      f.nodes.push(node);
      await link(node);
      return node;
    });
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      if (file === created) {
        planned = update(await f.vault.read(file));
        throw new Error('Origin-only destination failure');
      }
      return process(file, update);
    });
    f.paint();
    nativeClicks(f)(f.probe.surface.body.querySelector('mark'));
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'create',
      title: 'Created mention',
      type: 'Project',
    });
    passageButton(f.view, 'Convert to note link…').click();
    await expect(f.probe.operations).rejects.toThrow(/destination update was not saved/i);
    const source = await f.store.read(f.article.path);
    expect(source.body).toContain('[[Nodes/Created mention|first words]]');
    expect(passages(source.body)).toEqual([]);
    expect(readDocument(planned!).properties.origin).toBe(originLink(source.path, initial.blockId));
    expect(planned).not.toContain('## Highlights');
    expect(await f.vault.read(created)).not.toContain('## Highlights');
    expect(readDocument(await f.vault.read(created)).properties.origin).toBeUndefined();
    expect(await f.vault.read(f.targets[0])).toBe(first);
    expect(
      [...f.view.contentEl.querySelectorAll('button')].some(
        (button) => button.getAttribute('aria-label') === 'Retry note updates',
      ),
    ).toBe(false);
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
  });
  it('retries only the unfinished filing after choosing among another highlight’s many hosts with a staged draft', async () => {
    const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]);
    const second = hostSelection('Second excerpt.', { quote: 'Second excerpt.' }, [
      'Nodes/Project.md',
      'Nodes/Other.md',
    ]);
    const f = await fixture({ body: first.body + '\n\n' + second.body });
    const other = await f.note('Nodes/Other.md', 'Other note stays untouched.', 'concept');
    f.nodes.push({ ...f.nodes[0], path: other.path, title: 'Other' });
    const otherBytes = await f.vault.read(other),
      process = f.vault.process.bind(f.vault),
      calls: string[] = [];
    let failed = false;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      calls.push(file.path);
      if (file === f.targets[1] && !failed) {
        failed = true;
        throw new Error('Second chosen destination failed before process');
      }
      return process(file, update);
    });
    f.paint();
    const root = f.probe.surface.body as HTMLElement,
      click = nativeClicks(f);
    click(root.querySelectorAll('mark')[0]);
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'pick-in-article', nodes: [f.nodes[0]] });
    passageButton(f.view, 'Add highlight to notes…').click();
    await f.probe.operations;
    expect(f.probe.sendSource?.mode).toBe('explicit');
    mocks.choose.mockResolvedValueOnce(f.nodes[1]);
    click(root.querySelectorAll('mark')[1]);
    await expect(f.probe.operations).rejects.toThrow(/source annotation was saved/i);
    expect(mocks.choose).toHaveBeenCalledOnce();
    const source = await f.store.read(f.article.path),
      copy = await f.vault.read(f.targets[0]),
      before = calls.length;
    expect(copy).toContain('> First excerpt.');
    passageButton(f.view, 'Retry note updates').click();
    await f.probe.operations;
    expect(calls.slice(before)).toEqual([f.targets[1].path]);
    expect(await f.vault.read(f.article)).toBe(source.raw);
    expect(await f.vault.read(f.targets[0])).toBe(copy);
    expect(await f.vault.read(f.targets[1])).toContain('> First excerpt.');
    expect(await f.vault.read(f.targets[1])).not.toContain('> Second excerpt.');
    expect(await f.vault.read(other)).toBe(otherBytes);
    expect(f.api.createNodeForLink).not.toHaveBeenCalled();
  });
  it('collects one new range into every checked typed note with one guarded source annotation', async () => {
    const f = await fixture(),
      collect = vi.spyOn(f.store, 'collectHighlightMany');
    const process = vi.spyOn(f.vault, 'process');
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: f.nodes });
    await f.select();
    const saved = await f.store.read(f.article.path);
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ multiple: true, minSelection: 1, actionLabel: 'Add highlight' }),
    );
    expect(collect).toHaveBeenCalledOnce();
    expect(process.mock.calls.filter(([file]) => file === f.article)).toHaveLength(1);
    expect(passages(saved.body)[0].hosts).toEqual(['Nodes/Concept', 'Nodes/Project']);
    for (const target of f.targets)
      expect(await f.vault.read(target)).toContain('> first words (※ [[Reading/Inbox/Hosted#^');
  });
  it('collects checked existing notes and one created note inside the durable callback before required completion', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate();
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'create',
      title: 'Project',
      type: 'Project',
      existingNodes: [f.nodes[0]],
    });
    f.api.createNodeForLink.mockImplementation(async (_options, link) => {
      await link(f.nodes[1]);
      entered.resolve();
      await release.promise;
      return null;
    });
    const pending = f.select();
    await entered.promise;
    expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual([
      'Nodes/Concept',
      'Nodes/Project',
    ]);
    for (const target of f.targets) expect(await f.vault.read(target)).toContain('> first words');
    expect(readDocument(await f.vault.read(f.targets[0])).properties.origin).toBeUndefined();
    expect(readDocument(await f.vault.read(f.targets[1])).properties.origin).toContain('#^reader-');
    release.resolve();
    await pending;
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
    expect(f.api.createNode).not.toHaveBeenCalled();
    expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
  });
  it('cancels related-note drafts without writes, then applies metadata once without pruning earlier highlight copies', async () => {
    const f = await fixture({ defaults: [0] });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    const before = await f.store.read(f.article.path),
      copy = await f.vault.read(f.targets[0]);
    const set = vi.spyOn(f.store, 'setRelatedNodes');
    mocks.highlightPicker.mockResolvedValueOnce(null);
    await f.probe.topics();
    expect(f.probe.surface.topics.textContent).toBe('Concept');
    expect(set).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).raw).toBe(before.raw);
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [f.nodes[1]] });
    await f.probe.topics();
    expect(set).toHaveBeenCalledOnce();
    const saved = await f.store.read(f.article.path);
    expect(saved.properties.topics).toEqual(['[[Nodes/Project.md]]']);
    expect(f.probe.surface.topics.textContent).toBe('Project');
    expect(saved.body).toBe(before.body);
    expect(await f.vault.read(f.targets[0])).toBe(copy);
    expect(await f.vault.read(f.targets[1])).not.toContain('> first words');
  });
  it('links a created related note before completion but keeps other edits staged when Cancel follows', async () => {
    const f = await fixture({ defaults: [0] }),
      entered = gate(),
      release = gate();
    const file = await f.note('Nodes/New.md', 'New authored note.', 'different-primary');
    const created: NodeResult = {
      path: file.path,
      title: 'New',
      type: 'different-primary',
      classes: ['Concept'],
      aliases: [],
    };
    f.nodes.push(created);
    mocks.highlightPicker
      .mockResolvedValueOnce({
        kind: 'create',
        title: 'New',
        type: 'Concept',
        existingNodes: [f.nodes[1]],
      })
      .mockResolvedValueOnce(null);
    f.api.createNodeForLink.mockImplementation(async (_options, link) => {
      await link(created);
      entered.resolve();
      await release.promise;
      return created;
    });
    const pending = f.probe.topics();
    await entered.promise;
    expect((await f.store.read(f.article.path)).properties.topics).toEqual([
      '[[Nodes/Concept]]',
      '[[Nodes/New.md]]',
    ]);
    expect(await f.vault.read(file)).toContain('New authored note.');
    release.resolve();
    await pending;
    expect(mocks.highlightPicker).toHaveBeenLastCalledWith(
      f.app,
      f.api,
      expect.objectContaining({
        selectedPaths: ['Nodes/Project.md', 'Nodes/New.md'],
        allowCreate: false,
        actionLabel: 'Apply',
      }),
    );
    expect((await f.store.read(f.article.path)).properties.topics).toEqual([
      '[[Nodes/Concept]]',
      '[[Nodes/New.md]]',
    ]);
    expect(f.vault.trashed).toEqual([]);
  });
  it('opens a plain reference click as that passage multiselect when no highlight is selected', async () => {
    const body = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const f = await fixture({ body });
    f.paint();
    const click = nativeClicks(f);
    click(f.probe.surface.body.querySelector('.reader-reference-pill'));
    await f.probe.operations;
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({
        selectedPaths: ['Nodes/Concept.md'],
        minSelection: 0,
        multiple: true,
      }),
    );
    expect(f.opened.openFile).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe(body);
  });
  it.each(['plain', 'nested internal anchor'] as const)(
    'clicks the %s source highlight then an exact pill in a many-host passage, without arming Send',
    async (kind) => {
      const first =
        kind === 'plain'
          ? hostSelection('First excerpt.', { quote: 'First excerpt.' }, ['Nodes/Concept.md']).body
          : '[==First excerpt.==](Nodes/Concept.md) (※ [[Nodes/Concept]]) ^native-first';
      const second = hostSelection('Second excerpt.', { quote: 'Second excerpt.' }, [
        'Nodes/Concept.md',
        'Nodes/Project.md',
      ]).body;
      const f = await fixture({ body: `${first}\n\n${second}` }),
        conceptBefore = await f.vault.read(f.targets[0]);
      f.paint();
      const click = nativeClicks(f),
        root = f.probe.surface.body as HTMLElement;
      click(root.querySelector('mark')!);
      expect(f.probe.sendSource?.mode).toBe('selected');
      click(
        root.querySelector(
          '[data-reader-passage="1"] .reader-reference-pill[href="Nodes/Project"]',
        )!,
      );
      await f.probe.operations;
      const saved = await f.store.read(f.article.path);
      expect(passages(saved.body)[0].hosts).toEqual(['Nodes/Concept', 'Nodes/Project']);
      expect(saved.body).toContain(second);
      expect(await f.vault.read(f.targets[1])).toContain(
        kind === 'plain' ? '> First excerpt.' : '> [First excerpt.](Nodes/Concept.md)',
      );
      if (kind !== 'plain') expect(saved.body).toContain('[==First excerpt.==](Nodes/Concept.md)');
      expect(await f.vault.read(f.targets[1])).not.toContain('> Second excerpt.');
      expect(await f.vault.read(f.targets[0])).toBe(conceptBefore);
      expect(mocks.highlightPicker).not.toHaveBeenCalled();
      expect(f.opened.openFile).not.toHaveBeenCalled();
      expect(f.probe.sendSource?.snapshot.body).toBe(saved.body);
    },
  );
  it.each([false, true])(
    'routes an actual reference SVG path click with selected source=%s',
    async (selected) => {
      const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
        'Nodes/Concept.md',
      ]).body;
      const second = hostSelection('Second excerpt.', { quote: 'Second excerpt.' }, [
        'Nodes/Concept.md',
        'Nodes/Project.md',
      ]).body;
      const f = await fixture({ body: `${first}\n\n${second}` });
      f.nodes.forEach((node) => (node.icon = 'tag'));
      f.paint();
      const click = nativeClicks(f),
        root = f.probe.surface.body as HTMLElement,
        pill = root.querySelector<HTMLAnchorElement>(
          '[data-reader-passage="1"] .reader-reference-pill[href="Nodes/Project"]',
        )!;
      // The SDK shim does not load native Lucide paths. Reproduce its actual SVG
      // subtree so the dispatched event target is an SVGElement, not HTMLElement.
      const icon = pill.querySelector('.reader-node-icon') ?? document.createElement('span');
      icon.classList.add('reader-node-icon', 'reader-reference-icon');
      icon.setAttribute('data-reader-decoration', 'reference');
      icon.setAttribute('aria-hidden', 'true');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
        path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M2 2h12v12H2z');
      svg.append(path);
      icon.replaceChildren(svg);
      if (!icon.parentElement) pill.prepend(icon);
      if (selected) click(root.querySelector('mark')!);
      click(path);
      await f.probe.operations;
      expect(f.opened.openFile).not.toHaveBeenCalled();
      expect((await f.store.read(f.article.path)).body).toContain(second);
      if (selected) {
        expect(await f.vault.read(f.targets[1])).toContain('> First excerpt.');
        expect(await f.vault.read(f.targets[1])).not.toContain('> Second excerpt.');
        expect(await f.vault.read(f.targets[0])).not.toContain('> First excerpt.');
        expect(mocks.highlightPicker).not.toHaveBeenCalled();
      } else {
        expect(mocks.highlightPicker).toHaveBeenCalledWith(
          f.app,
          f.api,
          expect.objectContaining({ selectedPaths: ['Nodes/Concept.md', 'Nodes/Project.md'] }),
        );
        expect((await f.store.read(f.article.path)).body).toBe(`${first}\n\n${second}`);
        for (const target of f.targets) expect(await f.vault.read(target)).not.toContain('> ');
      }
    },
  );
  it('clicking a different mark switches the active source instead of sending the previous excerpt', async () => {
    const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const second = '[==Second excerpt.==](Nodes/Concept.md) (※ [[Nodes/Project]]) ^native-second';
    const f = await fixture({ body: `${first}\n\n${second}` });
    f.paint();
    const click = nativeClicks(f),
      root = f.probe.surface.body as HTMLElement;
    click(root.querySelectorAll('mark')[0]);
    click(root.querySelectorAll('mark')[1]);
    expect(f.probe.sendSource?.passage.text).toBe('Second excerpt.');
    for (const file of f.targets)
      expect(await f.vault.read(file)).not.toContain('> First excerpt.');
    expect((await f.store.read(f.article.path)).body).toBe(`${first}\n\n${second}`);
  });
  it.each(['Done', 'Escape', 'plain text'] as const)(
    'clears selected-source pill sending on %s',
    async (clear) => {
      const body =
        hostSelection('First excerpt.', { quote: 'First excerpt.' }, ['Nodes/Concept.md']).body +
        '\n\nBackground prose.';
      const f = await fixture({ body });
      f.paint();
      const click = nativeClicks(f),
        root = f.probe.surface.body as HTMLElement;
      click(root.querySelector('mark')!);
      expect(f.probe.sendSource).toBeDefined();
      if (clear === 'Done') passageButton(f.view, 'Done').click();
      else if (clear === 'Escape')
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      else click(root.querySelectorAll('p')[1]);
      expect(f.probe.sendSource).toBeUndefined();
      click(root.querySelector('.reader-reference-pill')!);
      await f.probe.operations;
      expect(mocks.highlightPicker).toHaveBeenCalledOnce();
      expect(await f.vault.read(f.targets[0])).not.toContain('> First excerpt.');
    },
  );
  it('shows existing topic aliases, untyped notes and unresolved labels without changing their metadata', async () => {
    const f = await fixture({ defaults: [0] });
    const legacy = await f.note('Nodes/Legacy.md', 'Authored legacy content.', 'not-registered');
    const before = await f.store.read(f.article.path);
    f.vault.bytes.set(
      f.article,
      patchProperties(before.raw, {
        topics: [
          '[[Nodes/Project.md|Project alias]]',
          `[[${legacy.path}|Legacy alias]]`,
          '[[Missing/Note|Missing alias]]',
          '[[Nodes/Project.md|Duplicate alias]]',
        ],
      }),
    );
    await f.view.changed({ path: f.article.path, metadataChanged: true });
    const source = (await f.store.read(f.article.path)).raw,
      body = f.probe.surface.body.firstChild;
    expect(f.probe.surface.topics.textContent).toBe('Project alias Legacy alias Missing alias');
    expect(f.probe.surface.topics.querySelectorAll('a')).toHaveLength(2);
    expect(f.probe.surface.topics.querySelector('.reader-reference-prefix')).toBeNull();
    f.api.getNode.mockImplementation(() => {
      throw new Error('Provider reloaded');
    });
    await f.view.changed({ path: legacy.path, metadataChanged: true });
    expect(f.probe.surface.topics.textContent).toBe('Project alias Legacy alias Missing alias');
    expect(f.probe.surface.body.firstChild).toBe(body);
    expect((await f.store.read(f.article.path)).raw).toBe(source);
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
  });
  it.each([
    { ctrlKey: false, metaKey: false, button: 0, newLeaf: false },
    { ctrlKey: true, metaKey: false, button: 0, newLeaf: true },
    { ctrlKey: false, metaKey: true, button: 0, newLeaf: true },
    { ctrlKey: false, metaKey: false, button: 1, newLeaf: true },
  ])(
    'navigates header topics without invoking highlight filing: %j',
    async ({ newLeaf, ...options }) => {
      const f = await fixture({ defaults: [0] }),
        before = (await f.store.read(f.article.path)).raw,
        target = await f.vault.read(f.targets[0]),
        open = vi.spyOn(f.probe, 'openLinked').mockResolvedValue(undefined),
        bodyClick = vi.spyOn(f.probe, 'targetClicked');
      const link = f.probe.surface.topics.querySelector('a')!;
      link.dispatchEvent(
        new MouseEvent(options.button === 1 ? 'auxclick' : 'click', {
          ...options,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(open).toHaveBeenCalledWith(f.targets[0].path, newLeaf);
      expect(bodyClick).not.toHaveBeenCalled();
      expect(mocks.highlightPicker).not.toHaveBeenCalled();
      expect((await f.store.read(f.article.path)).raw).toBe(before);
      expect(await f.vault.read(f.targets[0])).toBe(target);
    },
  );
  it('unchecks one of two filed notes through Apply, removing only its exact quotation', async () => {
    const f = await fixture({ defaults: [0, 1] });
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: f.nodes });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const before = await f.store.read(f.article.path),
      anchor = paragraphAnchors(before.body)[0].blockId,
      retained = await f.vault.read(f.targets[0]),
      removed = await f.vault.read(f.targets[1]),
      expected = removeQuotation(
        removed,
        'first words',
        originLink(before.path, anchor, 'Hosted'),
      ).raw;
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [f.nodes[0]] });
    await menu(f.view, 'Add highlight to notes…');
    expect(mocks.highlightPicker).toHaveBeenLastCalledWith(
      f.app,
      f.api,
      expect.objectContaining({
        query: '',
        selectedPaths: f.nodes.map((node) => node.path),
        minSelection: 0,
        actionLabel: 'Apply',
      }),
    );
    const saved = await f.store.read(f.article.path);
    expect(passages(saved.body)[0].hosts).toEqual(['Nodes/Concept']);
    expect(passages(saved.body)[0].text).toBe('first words');
    expect(paragraphAnchors(saved.body)[0].blockId).toBe(anchor);
    expect(saved.properties.topics).toEqual(before.properties.topics);
    expect(await f.vault.read(f.targets[0])).toBe(retained);
    expect(await f.vault.read(f.targets[1])).toBe(expected);
    expect(f.vault.trashed).toEqual([]);
  });
  it('clears the last checked host and its exact copy while keeping text, anchors, defaults, and unrelated snapshots', async () => {
    const f = await fixture({ defaults: [0] });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const original = await f.store.read(f.article.path),
      anchor = paragraphAnchors(original.body)[0].blockId;
    f.vault.bytes.set(
      f.targets[0],
      appendQuotation(
        await f.vault.read(f.targets[0]),
        'Unrelated owned snapshot.',
        originLink('Other/Source.md', 'native-other', 'Other'),
      ).raw,
    );
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [] });
    await menu(f.view, 'Add highlight to notes…');
    const saved = await f.store.read(f.article.path),
      target = await f.vault.read(f.targets[0]);
    expect(passages(saved.body)).toEqual([]);
    expect(saved.body).toContain('Before first words after.');
    expect(saved.body).toContain(`^${anchor}`);
    expect(saved.properties.topics).toEqual(original.properties.topics);
    expect(target).not.toContain('> first words');
    expect(target).toContain('> Unrelated owned snapshot.');
    expect(target).toContain('Authored concept.');
    expect(f.vault.trashed).toEqual([]);
    expect(f.probe.tapUndo).toBeUndefined();
  });
  it('refuses an explicit uncheck before any source mutation when the filed quotation was edited', async () => {
    const f = await fixture({ defaults: [0] });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const target = (await f.vault.read(f.targets[0])).replace(
      '> first words',
      '> User edited these words',
    );
    f.vault.bytes.set(f.targets[0], target);
    const original = await f.store.read(f.article.path),
      process = vi.spyOn(f.vault, 'process');
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [] });
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(/quotation/i);
    expect((await f.store.read(f.article.path)).raw).toBe(original.raw);
    expect(await f.vault.read(f.targets[0])).toBe(target);
    expect(process.mock.calls.filter(([file]) => file === f.article)).toHaveLength(0);
  });
  it('retries only unfinished explicit removals after a source-first partial failure', async () => {
    const f = await fixture();
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: f.nodes });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const process = f.vault.process.bind(f.vault);
    let fail = true;
    const calls: string[] = [];
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      calls.push(file.path);
      if (file === f.targets[1] && fail) {
        fail = false;
        throw new Error('Temporarily blocked destination');
      }
      return process(file, update);
    });
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [] });
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
      /source annotation was saved/i,
    );
    expect(passages((await f.store.read(f.article.path)).body)).toEqual([]);
    expect(await f.vault.read(f.targets[0])).not.toContain('> first words');
    expect(await f.vault.read(f.targets[1])).toContain('> first words');
    passageButton(f.view, 'Retry note updates').click();
    await f.probe.operations;
    for (const file of f.targets) expect(await f.vault.read(file)).not.toContain('> first words');
    expect(calls.filter((path) => path === f.targets[0].path)).toHaveLength(1);
    expect(calls.filter((path) => path === f.targets[1].path)).toHaveLength(2);
    expect(f.vault.trashed).toEqual([]);
  });
  it('paints public resolved node icons before listed-class fallback, stripping fragments and tolerating provider failure', async () => {
    const f = await fixture(),
      icon = document.createElement('span');
    f.nodes[0].icon = 'star';
    f.api.listTypes.mockReturnValue([
      { type: 'Project', label: 'Project', icon: 'briefcase' },
      { type: 'Concept', label: 'Concept', icon: 'book' },
    ] as any);
    vi.mocked(setIcon).mockClear();
    f.probe.paintReferenceIcon('Nodes/Concept#Heading', icon, f.article);
    expect(setIcon).toHaveBeenLastCalledWith(icon, 'star');
    delete f.nodes[0].icon;
    f.probe.paintReferenceIcon('Nodes/Concept#^native-existing', icon, f.article);
    expect(setIcon).toHaveBeenLastCalledWith(icon, 'book');
    f.nodes[0].classes = ['Concept', 'Project'];
    f.api.listTypes.mockReturnValue([
      { type: 'Concept', label: 'Concept' },
      { type: 'Project', label: 'Project', icon: 'notebook' },
    ] as any);
    f.probe.paintReferenceIcon('Nodes/Concept', icon, f.article);
    expect(setIcon).toHaveBeenLastCalledWith(icon, 'notebook');
    vi.mocked(setIcon).mockClear();
    f.nodes[0].icon = '';
    f.probe.paintReferenceIcon('Nodes/Concept', icon, f.article);
    expect(setIcon).not.toHaveBeenCalled();
    delete f.nodes[0].icon;
    f.nodes[0].classes = ['NotRegistered'];
    f.probe.paintReferenceIcon('Nodes/Concept', icon, f.article);
    expect(setIcon).not.toHaveBeenCalled();
    f.api.getNode.mockImplementationOnce(() => {
      throw new Error('Provider unavailable');
    });
    expect(() => f.probe.paintReferenceIcon('Nodes/Concept', icon, f.article)).not.toThrow();
  });
  it.each(['revoked membership', 'replacement file'] as const)(
    'does not erase an unchecked related-note original after %s at the final source boundary',
    async (change) => {
      const f = await fixture({ defaults: [0] }),
        before = await f.store.read(f.article.path);
      mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [] });
      const process = f.vault.process.bind(f.vault);
      let changed = false;
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
        if (file === f.article && !changed) {
          changed = true;
          if (change === 'revoked membership') f.nodes[0].classes = [];
          else {
            const replacement = Object.setPrototypeOf(
              { ...f.targets[0] },
              TFile.prototype,
            ) as TFile;
            f.vault.files.set(replacement.path, replacement);
            f.vault.bytes.set(replacement, await f.vault.read(f.targets[0]));
            f.cache.set(replacement, f.cache.get(f.targets[0]));
          }
        }
        return process(file, update);
      });
      await f.probe.topics();
      expect(changed).toBe(true);
      expect(mocks.notice).toHaveBeenCalledWith(
        expect.stringMatching(
          change === 'replacement file'
            ? /note changed.*Nothing was overwritten/
            : /typed destination changed/,
        ),
      );
      expect((await f.store.read(f.article.path)).raw).toBe(before.raw);
      expect(mocks.highlightPicker).toHaveBeenCalledTimes(2);
      expect(f.api.createNodeForLink).not.toHaveBeenCalled();
    },
  );
  it.each([{ ctrlKey: true }, { metaKey: true }, { button: 1 }])(
    'keeps modified reference navigation available with a source highlight active (%j)',
    async (init) => {
      const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
        'Nodes/Concept.md',
      ]).body;
      const second = hostSelection('Second excerpt.', { quote: 'Second excerpt.' }, [
        'Nodes/Project.md',
      ]).body;
      const f = await fixture({ body: `${first}\n\n${second}` });
      f.paint();
      const click = nativeClicks(f),
        root = f.probe.surface.body as HTMLElement;
      click(root.querySelector('mark')!);
      expect(f.probe.sendSource).toBeDefined();
      click(root.querySelector('[data-reader-passage="1"] .reader-reference-pill')!, init);
      for (let i = 0; i < 100 && !f.opened.openFile.mock.calls.length; i++) await Promise.resolve();
      expect(f.opened.openFile).toHaveBeenCalledOnce();
      expect(f.opened.openFile).toHaveBeenCalledWith(f.targets[1], { active: true });
      expect(f.probe.sendSource).toBeUndefined();
      expect(mocks.highlightPicker).not.toHaveBeenCalled();
      for (const target of f.targets)
        expect(await f.vault.read(target)).not.toContain('> First excerpt.');
      expect((await f.store.read(f.article.path)).body).toBe(`${first}\n\n${second}`);
    },
  );
  it('keeps a fresh source snapshot for repeated exact-pill filings without duplicating quotation copies', async () => {
    const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const second = hostSelection('Second excerpt.', { quote: 'Second excerpt.' }, [
      'Nodes/Project.md',
    ]).body;
    const f = await fixture({ body: `${first}\n\n${second}` });
    f.paint();
    const click = nativeClicks(f),
      root = f.probe.surface.body as HTMLElement;
    click(root.querySelector('mark')!);
    click(root.querySelector('[data-reader-passage="1"] .reader-reference-pill')!);
    await f.probe.operations;
    const filed = await f.vault.read(f.targets[1]);
    f.paint();
    click(root.querySelector('[data-reader-passage="1"] .reader-reference-pill')!);
    await f.probe.operations;
    expect(await f.vault.read(f.targets[1])).toBe(filed);
    expect(filed.match(/> First excerpt\./g)).toHaveLength(1);
    expect(f.probe.sendSource?.snapshot.body).toBe((await f.store.read(f.article.path)).body);
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
  });
  it('retries an unfinished removal without repeating a completed created-note collection or origin write', async () => {
    const f = await fixture({ defaults: [0] });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const process = f.vault.process.bind(f.vault),
      calls: string[] = [];
    let fail = true;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      calls.push(file.path);
      if (file === f.targets[0] && fail) {
        fail = false;
        throw new Error('Temporary removal failure');
      }
      return process(file, update);
    });
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'create',
      title: 'Project',
      type: 'Project',
    });
    f.api.createNodeForLink.mockImplementationOnce(async (_options, link) => {
      await link(f.nodes[1]);
      return f.nodes[1];
    });
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
      /source annotation was saved/i,
    );
    const createdCopy = await f.vault.read(f.targets[1]);
    expect(createdCopy).toContain('> first words');
    expect(readDocument(createdCopy).properties.origin).toContain('#^reader-');
    passageButton(f.view, 'Retry note updates').click();
    await f.probe.operations;
    expect(await f.vault.read(f.targets[1])).toBe(createdCopy);
    expect(await f.vault.read(f.targets[0])).not.toContain('> first words');
    expect(calls.filter((path) => path === f.targets[1].path)).toHaveLength(1);
    expect(calls.filter((path) => path === f.targets[0].path)).toHaveLength(2);
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
  });
  it('converts a hosted highlight to a note link without removing any earlier filed quotation', async () => {
    const f = await fixture({ defaults: [0] });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const copy = await f.vault.read(f.targets[0]);
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing', node: f.nodes[1] });
    await menu(f.view, 'Convert to note link…');
    expect((await f.store.read(f.article.path)).body).toContain('[[Nodes/Project|first words]]');
    expect(await f.vault.read(f.targets[0])).toBe(copy);
    expect(await f.vault.read(f.targets[1])).not.toContain('> first words');
  });
  it('requires a picker when no typed default exists and cancellation writes neither file', async () => {
    const f = await fixture(),
      before = await f.store.read(f.article.path),
      target = await f.vault.read(f.targets[0]);
    await f.select();
    expect(mocks.highlightPicker).toHaveBeenCalledOnce();
    expect(await f.store.read(f.article.path)).toEqual(before);
    expect(await f.vault.read(f.targets[0])).toBe(target);
    expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
    expect(f.api.createNode).not.toHaveBeenCalled();
  });
  it.each([0, 1])(
    'inherits one valid typed destination of any class (destination %i)',
    async (index) => {
      const f = await fixture({ defaults: [index] });
      await f.select();
      const saved = await f.store.read(f.article.path);
      expect(mocks.highlightPicker).not.toHaveBeenCalled();
      expect(passages(saved.body)[0].hosts).toEqual([f.nodes[index].path.replace(/\.md$/, '')]);
      expect(await f.vault.read(f.targets[index])).toContain(
        '> first words (※ [[Reading/Inbox/Hosted#^reader-',
      );
      expect(saved.properties.topics).toEqual([`[[${f.nodes[index].path.replace(/\.md$/, '')}]]`]);
    },
  );
  it('offers several defaults without silently choosing the first, and remembers an explicit new choice', async () => {
    const f = await fixture({ defaults: [0, 1] });
    await f.select();
    expect((await f.store.read(f.article.path)).body).toBe('Before first words after.');
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ preferredPaths: f.nodes.map((node) => node.path) }),
    );
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[1] });
    f.probe.lastSelection = '';
    await f.select();
    expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual(['Nodes/Project']);
    expect(await f.vault.read(f.targets[0])).not.toContain('## Highlights');
  });
  it('ignores invalid/untyped defaults instead of treating arbitrary files as hosts', async () => {
    const f = await fixture({ defaults: [0] });
    f.nodes[0].classes = ['NotAFileclass'];
    await f.select();
    expect(mocks.highlightPicker).toHaveBeenCalledOnce();
    expect((await f.store.read(f.article.path)).body).toBe('Before first words after.');
  });
  it('shows a clear provider error for new highlights while keeping legacy removal usable', async () => {
    const f = await fixture();
    (f.app as any).plugins = undefined;
    await expect(f.select()).rejects.toThrow(/Fileclass Inline.*v2/);
    expect((await f.store.read(f.article.path)).body).toBe('Before first words after.');
    const old = await f.note('Reading/Inbox/Legacy.md', 'Before ==legacy== after.');
    await f.view.openArticle(old.path);
    await menu(f.view, 'Remove highlight (article only)');
    expect((await f.store.read(old.path)).body).toBe('Before legacy after.');
  });
  it('uses createNodeForLink before required completion, accepts membership rather than primary type, and never invokes a shared picker', async () => {
    const f = await fixture();
    mocks.highlightPicker.mockResolvedValue({
      kind: 'create',
      title: 'Typed project',
      type: 'Project',
    });
    f.api.createNodeForLink.mockImplementation(async (options, link) => {
      expect(options).toMatchObject({
        type: 'Project',
        suggestedTitle: 'Typed project',
        sourcePath: f.article.path,
      });
      await link(f.nodes[1]);
      expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual([
        'Nodes/Project',
      ]);
      expect(await f.vault.read(f.targets[1])).toContain('## Highlights');
      expect(readDocument(await f.vault.read(f.targets[1])).properties.origin).toMatch(
        /Hosted#\^reader-/,
      );
      return null; // Completion cancellation never rolls back a created node/source.
    });
    await f.select();
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
    expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
    expect(f.api.createNode).not.toHaveBeenCalled();
    expect(f.vault.file(f.targets[1].path)).toBe(f.targets[1]);
  });
  it('rejects a created node without the selected class and a duplicate callback', async () => {
    const f = await fixture();
    mocks.highlightPicker.mockResolvedValue({ kind: 'create', title: 'Project', type: 'Project' });
    f.api.createNodeForLink.mockImplementation(async (_options, link) => {
      await link(f.nodes[1]);
      await expect(link(f.nodes[1])).rejects.toThrow(/already ran/);
      return f.nodes[1];
    });
    await f.select();
    expect((await f.vault.read(f.targets[1])).match(/> first words/g)).toHaveLength(1);
    const other = await fixture();
    mocks.highlightPicker.mockResolvedValue({
      kind: 'create',
      title: 'Wrong class',
      type: 'Project',
    });
    other.api.createNodeForLink.mockImplementation(async (_options, link) => {
      await link(other.nodes[0]);
      return other.nodes[0];
    });
    await expect(other.select()).rejects.toThrow(/chosen Fileclass/);
    expect((await other.store.read(other.article.path)).body).toBe('Before first words after.');
  });
  it.each(['provider', 'classes', 'source'] as const)(
    'rechecks %s at the callback mutation boundary',
    async (change) => {
      const f = await fixture(),
        targetRaw = await f.vault.read(f.targets[0]);
      mocks.highlightPicker.mockResolvedValue({
        kind: 'create',
        title: 'Concept',
        type: 'Concept',
      });
      f.api.createNodeForLink.mockImplementation(async (_options, link) => {
        if (change === 'provider')
          (f.app as any).plugins = { getPlugin: () => ({ api: { ...f.api } }) };
        else if (change === 'classes') f.nodes[0].classes = ['Other'];
        else f.vault.bytes.set(f.article, `${await f.vault.read(f.article)}\nExternal edit.`);
        await link(f.nodes[0]);
        return f.nodes[0];
      });
      await expect(f.select()).rejects.toThrow();
      expect(await f.vault.read(f.targets[0])).toBe(targetRaw);
      expect((await f.store.read(f.article.path)).body).not.toContain('==');
    },
  );
  it.each([false, true])(
    'cancels an uncooperative creation provider without losing dispatched content (committed=%s)',
    async (committed) => {
      const f = await fixture({ body: '==first words==' }),
        entered = gate();
      mocks.highlightPicker.mockResolvedValue({
        kind: 'create',
        title: 'Concept',
        type: 'Concept',
      });
      let callback!: (node: NodeResult) => Promise<void>;
      f.api.createNodeForLink.mockImplementation(async (_options, link) => {
        callback = link;
        if (committed) await link(f.nodes[0]);
        entered.resolve();
        return new Promise<never>(() => {});
      });
      const pending = menu(f.view, 'Add highlight to notes…');
      await entered.promise;
      const leaving = f.view.readingList();
      await leaving;
      await pending;
      await expect(callback(f.nodes[0])).rejects.toThrow(/cancelled/);
      expect(f.probe.snapshot).toBeUndefined();
      expect((await f.store.read(f.article.path)).body.includes('(※')).toBe(committed);
      expect((await f.vault.read(f.targets[0])).includes('## Highlights')).toBe(committed);
    },
  );
  it('drains an already-dispatched target write before navigation and never rolls it back', async () => {
    const f = await fixture({ body: '==first words==' }),
      entered = gate(),
      release = gate();
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[0] });
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      const result = await process(file, update);
      if (file === f.targets[0]) {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const pending = menu(f.view, 'Add highlight to notes…');
    await entered.promise;
    let left = false;
    const leaving = f.view.readingList().then(() => {
      left = true;
    });
    await Promise.resolve();
    expect(left).toBe(false);
    expect(await f.vault.read(f.targets[0])).toContain('## Highlights');
    release.resolve();
    await leaving;
    await pending.catch(() => {}); // Cancellation may report an already-dispatched save as uncertain.
    expect((await f.store.read(f.article.path)).body).toContain('(※ [[Nodes/Concept]])');
    expect(await f.vault.read(f.targets[0])).toContain('> first words');
  });
  it('routes the first excerpt to a second highlight host and leaves the second passage unchanged', async () => {
    const body = hostSelection('First excerpt.\n\nSecond excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const second = hostSelection(body, { quote: 'Second excerpt.' }, ['Nodes/Project.md']);
    const f = await fixture({ body: second.body });
    f.paint();
    f.probe.passageMenu(passages(f.probe.snapshot.body)[0]);
    await menu(f.view, 'Choose from article…');
    expect(passageButton(f.view, 'Cancel choosing from article')).toBeDefined();
    f.probe.selectPassageMark(
      f.probe.surface.body.querySelectorAll('mark')[1],
      new MouseEvent('click'),
    );
    await f.probe.operations;
    const saved = await f.store.read(f.article.path),
      found = passages(saved.body);
    expect(found[0].hosts).toEqual(['Nodes/Concept', 'Nodes/Project']);
    expect(found[1].hosts).toEqual(['Nodes/Project']);
    expect(found[1].text).toBe('Second excerpt.');
    const firstAnchor = /\^(reader-[a-z0-9-]+)/.exec(saved.body)![1];
    const target = await f.vault.read(f.targets[1]);
    expect(target).toContain(`> First excerpt. (※ [[Reading/Inbox/Hosted#^${firstAnchor}`);
    expect(target).not.toContain('> Second excerpt.');
  });
  it('sends to the actual highlight host when a mark is inside an internal link with a different target', async () => {
    const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const second = '[==Second excerpt.==](Nodes/Concept.md) (※ [[Nodes/Project]]) ^native-existing';
    const f = await fixture({ body: `${first}\n\n${second}` });
    f.vault.bytes.set(
      f.targets[0],
      appendQuotation(
        await f.vault.read(f.targets[0]),
        'First excerpt.',
        originLink(f.article.path, paragraphAnchors(first)[0].blockId, 'Hosted'),
      ).raw,
    );
    const conceptBefore = await f.vault.read(f.targets[0]);
    f.paint();
    f.probe.passageMenu(passages(f.probe.snapshot.body)[0]);
    await menu(f.view, 'Choose from article…');
    const mark = f.probe.surface.body.querySelectorAll('mark')[1] as HTMLElement;
    expect(mark.parentElement?.matches('a.internal-link')).toBe(true);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(click, 'target', { value: mark });
    // Native caret hit-testing belongs to the TapHighlighter. Verify its two
    // Reader callbacks separately: the inline-link interceptor must decline the
    // marked text, then the mapped logical passage supplies the actual host.
    expect(f.probe.targetClicked(click)).toBe(false);
    f.probe.selectPassageMark(mark, click);
    await f.probe.operations;
    const saved = await f.store.read(f.article.path);
    expect(passages(saved.body)[0].hosts).toEqual(['Nodes/Concept', 'Nodes/Project']);
    expect(saved.body).toContain(second);
    expect(await f.vault.read(f.targets[1])).toContain('> First excerpt.');
    expect(await f.vault.read(f.targets[1])).not.toContain('> Second excerpt.');
    expect(await f.vault.read(f.targets[0])).toBe(conceptBefore);
    expect(mocks.choose).not.toHaveBeenCalled();
    expect(mocks.highlightPicker).toHaveBeenCalledOnce();
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ allowPickFromArticle: true, multiple: true }),
    );
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });
  it('still uses an internal link exact target when its unmarked portion is clicked', async () => {
    const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const second =
      '[Unmarked ==Second excerpt.==](Nodes/Concept.md) (※ [[Nodes/Project]]) ^native-existing';
    const f = await fixture({ body: `${first}\n\n${second}` });
    const projectBefore = await f.vault.read(f.targets[1]);
    f.paint();
    f.probe.passageMenu(passages(f.probe.snapshot.body)[0]);
    await menu(f.view, 'Choose from article…');
    const link = f.probe.surface.body.querySelector(
      'a.internal-link[href="Nodes/Concept.md"]',
    ) as HTMLAnchorElement;
    expect(link.querySelector('mark')).not.toBeNull();
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true });
      link.dispatchEvent(event);
    }
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toContain(second);
    expect(await f.vault.read(f.targets[0])).toContain('> First excerpt.');
    expect(await f.vault.read(f.targets[1])).toBe(projectBefore);
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });
  it('requires an explicit choice among multiple second-highlight hosts and supports Cancel choosing from article', async () => {
    let body = hostSelection('First excerpt.\n\nSecond excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    body = hostSelection(body, { quote: 'Second excerpt.' }, [
      'Nodes/Concept.md',
      'Nodes/Project.md',
    ]).body;
    const f = await fixture({ body });
    f.paint();
    f.probe.passageMenu(passages(f.probe.snapshot.body)[0]);
    await menu(f.view, 'Choose from article…');
    passageButton(f.view, 'Cancel choosing from article').click();
    expect(f.probe.sendSource).toBeUndefined();
    expect((await f.store.read(f.article.path)).body).toBe(body);
    await menu(f.view, 'Choose from article…');
    mocks.choose.mockResolvedValue(null);
    f.probe.selectPassageMark(
      f.probe.surface.body.querySelectorAll('mark')[1],
      new MouseEvent('click'),
    );
    await f.probe.operations;
    expect(mocks.choose).toHaveBeenCalledWith(
      f.app,
      'Add highlight to notes',
      f.nodes,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect((await f.store.read(f.article.path)).body).toBe(body);
  });
  it.each(['inline', 'reference'] as const)(
    'routes to the exact typed %s link rather than opening it',
    async (kind) => {
      const base = hostSelection('First excerpt.\n\nSecond excerpt.', { quote: 'First excerpt.' }, [
        'Nodes/Concept.md',
      ]).body;
      const body =
        kind === 'reference'
          ? hostSelection(base, { quote: 'Second excerpt.' }, ['Nodes/Project.md']).body
          : `${base}\n\n[[Nodes/Project.md|Project link]]`;
      const f = await fixture({ body });
      f.paint();
      f.probe.passageMenu(passages(f.probe.snapshot.body)[0]);
      await menu(f.view, 'Choose from article…');
      const links = [
        ...(f.probe.surface.body as HTMLElement).querySelectorAll<HTMLAnchorElement>(
          'a.internal-link',
        ),
      ];
      const link = links.find(
        (link) => link.getAttribute('href')?.replace(/\.md$/, '') === 'Nodes/Project',
      )!;
      for (const type of ['pointerdown', 'pointerup']) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true });
        Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true });
        link.dispatchEvent(event);
      }
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await f.probe.operations;
      expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual([
        'Nodes/Concept',
        'Nodes/Project',
      ]);
      expect(f.opened.openFile).not.toHaveBeenCalled();
    },
  );
  it('Undo removes only the source mark/references, retaining anchors, defaults, and user-owned destination snapshots', async () => {
    const f = await fixture({ defaults: [0] });
    f.paint();
    const range = document.createRange(),
      node = f.probe.surface.body.querySelector('p').firstChild;
    range.setStart(node, 7);
    range.setEnd(node, 18);
    await f.probe.saveTapSelection(f.probe.surface.body, range);
    const target = await f.vault.read(f.targets[0]),
      saved = await f.store.read(f.article.path);
    const anchor = /\^reader-[a-z0-9-]+/.exec(saved.body)![0];
    passageButton(f.view, 'Undo').click();
    await f.probe.operations;
    const undone = await f.store.read(f.article.path);
    expect(undone.body).toBe(`Before first words after. ${anchor}`);
    expect(undone.properties.topics).toEqual(saved.properties.topics);
    expect(await f.vault.read(f.targets[0])).toBe(target);
  });
  it('explicitly unchecks a destination by removing its exact filed quotation while retaining defaults and the new destination', async () => {
    const f = await fixture({ body: '==first words==' });
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[0] });
    await menu(f.view, 'Add highlight to notes…');
    const firstSnapshot = await f.vault.read(f.targets[0]);
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[1] });
    await menu(f.view, 'Add highlight to notes…');
    const source = await f.store.read(f.article.path);
    expect(passages(source.body)[0].hosts).toEqual(['Nodes/Project']);
    expect(firstSnapshot).toContain('> first words');
    expect(await f.vault.read(f.targets[0])).not.toContain('> first words');
    expect(await f.vault.read(f.targets[0])).toContain('Authored concept.');
    expect(await f.vault.read(f.targets[1])).toContain('> first words');
    expect(source.properties.topics).toEqual(['[[Nodes/Concept]]', '[[Nodes/Project]]']);
  });
  it('converts only on explicit intent into an ordinary node alias without a redundant pill or quotation', async () => {
    const initial = hostSelection('first words', { quote: 'first words' }, ['Nodes/Concept.md']);
    const f = await fixture({ body: initial.body }),
      target = await f.vault.read(f.targets[1]);
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[1] });
    await menu(f.view, 'Convert to note link…');
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ query: 'first words' }),
    );
    const saved = await f.store.read(f.article.path);
    expect(saved.body).toBe(`[[Nodes/Project|first words]] ^${initial.blockId}`);
    expect(await f.vault.read(f.targets[1])).toBe(target);
    expect(passages(saved.body)).toEqual([]);
  });
  it('links a fresh tap range to an explicitly chosen typed note without saving a highlight or quotation', async () => {
    const f = await fixture({ defaults: [0] });
    f.paint();
    const range = document.createRange(),
      node = f.probe.surface.body.querySelector('p').firstChild;
    range.setStart(node, 7);
    range.setEnd(node, 18);
    const originalTarget = await f.vault.read(f.targets[1]);
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[1] });
    await f.probe.saveTapNode(f.probe.surface.body, range);
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ query: 'first words', multiple: false }),
    );
    const saved = await f.store.read(f.article.path);
    expect(saved.body).toMatch(/Before \[\[Nodes\/Project\|first words\]\] after\. \^reader-/);
    expect(saved.body).not.toContain('==');
    expect(await f.vault.read(f.targets[1])).toBe(originalTarget);
    expect(f.api.createNodeForLink).not.toHaveBeenCalled();
  });
  it('commits the source link and birth origin through public typed creation before required completion', async () => {
    const f = await fixture();
    f.paint();
    const range = document.createRange(),
      node = f.probe.surface.body.querySelector('p').firstChild;
    range.setStart(node, 7);
    range.setEnd(node, 18);
    mocks.highlightPicker.mockResolvedValue({
      kind: 'create',
      title: 'First words',
      type: 'Concept',
    });
    f.api.createNodeForLink.mockImplementation(async (_options, link) => {
      await link(f.nodes[0]);
      const saved = await f.store.read(f.article.path);
      expect(saved.body).toContain('[[Nodes/Concept|first words]]');
      expect(saved.body).not.toContain('==');
      return f.nodes[0];
    });
    await f.probe.saveTapNode(f.probe.surface.body, range);
    const saved = await f.store.read(f.article.path);
    const anchor = /\^reader-[a-z0-9-]+/.exec(saved.body)![0];
    expect(await f.vault.read(f.targets[0])).toContain(
      `origin: "[[${saved.path.replace(/\.md$/, '')}#${anchor}]]"`,
    );
    expect(await f.vault.read(f.targets[0])).not.toContain('## Highlights');
  });
  it('never converts automatically when a selected excerpt equals the node title', async () => {
    const f = await fixture({ defaults: [0] });
    f.nodes[0].title = 'first words';
    await f.select();
    expect(passages((await f.store.read(f.article.path)).body)).toHaveLength(1);
    expect(await f.vault.read(f.targets[0])).toContain('> first words');
  });
  it('preserves a Reader position write while a creation callback is pending', async () => {
    const f = await fixture({ body: '==first words==' });
    mocks.highlightPicker.mockResolvedValue({ kind: 'create', title: 'Concept', type: 'Concept' });
    f.api.createNodeForLink.mockImplementation(async (_options, link) => {
      f.probe.persistPosition('first words');
      await f.probe.positionWrite;
      await link(f.nodes[0]);
      return f.nodes[0];
    });
    await menu(f.view, 'Add highlight to notes…');
    const saved = await f.store.read(f.article.path);
    expect(saved.properties.bookmark).toBe('first words');
    expect(passages(saved.body)[0].hosts).toEqual(['Nodes/Concept']);
  });
  it('preserves other typed remembered destinations through existing topic assignment without reclassifying them', async () => {
    const f = await fixture({ defaults: [0, 1] });
    const topic = await f.note('Topics/Real.md', 'A topic.', 'topic');
    f.nodes.push({
      path: topic.path,
      title: 'Real',
      type: 'different-primary',
      classes: ['Concept'],
      aliases: [],
    });
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: f.nodes });
    await f.probe.topics();
    const saved = await f.store.read(f.article.path);
    expect(saved.properties.topics).toEqual([
      '[[Nodes/Concept]]',
      '[[Nodes/Project]]',
      '[[Topics/Real.md]]',
    ]);
    expect(readDocument(await f.vault.read(f.targets[1])).properties.type).toBe('project');
  });
  it('offers only public Fileclass destinations in article assignment and preserves ineligible legacy YAML', async () => {
    const f = await fixture();
    const untyped = await f.note('Topics/Untyped.md', 'An old untyped topic.', 'topic');
    const legacy = ['[[Topics/Untyped.md]]', 'unrecognized authored value', { custom: 'preserve' }];
    f.vault.bytes.set(
      f.article,
      patchProperties(await f.vault.read(f.article), { topics: legacy }),
    );
    await f.view.openArticle(f.article.path);
    mocks.highlightPicker.mockImplementationOnce(async (_app, api, options) => {
      expect(api).toBe(f.api);
      expect(options).toEqual(
        expect.objectContaining({
          multiple: true,
          selectedPaths: [],
          minSelection: 0,
          actionLabel: 'Apply',
          title: 'Related notes',
        }),
      );
      expect(api.getNode(untyped.path)).toBeNull();
      return { kind: 'existing-many', nodes: [f.nodes[1]] };
    });
    await f.probe.topics();
    expect((await f.store.read(f.article.path)).properties.topics).toEqual([
      ...legacy,
      '[[Nodes/Project.md]]',
    ]);
    expect(readDocument(await f.vault.read(untyped)).properties.type).toBe('topic');
  });
  it('blocks assignment without the public provider but retains read-only legacy topic filtering', async () => {
    const f = await fixture();
    const legacy = await f.note('Topics/Legacy.md', 'An ordinary legacy topic.', 'topic');
    (f.app as any).plugins = undefined;
    await expect(f.probe.topics()).rejects.toThrow(/Fileclass Inline.*v2/);
    expect(mocks.topics).not.toHaveBeenCalled();
    await f.view.readingList();
    const { chooseTopicFilter } = await import('../src/host/topic-filter-dialog');
    vi.mocked(chooseTopicFilter).mockResolvedValueOnce(null);
    await f.probe.selectTopicFilter();
    expect(chooseTopicFilter).toHaveBeenCalledWith(
      f.app,
      expect.arrayContaining([expect.objectContaining({ path: legacy.path })]),
      undefined,
      expect.any(AbortSignal),
    );
  });
  it('rechecks assigned Fileclass membership inside the final source transform', async () => {
    const f = await fixture(),
      original = await f.store.read(f.article.path);
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [f.nodes[0]] });
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
      f.nodes[0].classes = ['NotRegistered'];
      return process(file, transform);
    });
    await f.probe.topics();
    expect(mocks.notice).toHaveBeenCalledWith(expect.stringMatching(/typed destination changed/));
    expect(mocks.highlightPicker).toHaveBeenLastCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ selectedPaths: [f.nodes[0].path] }),
    );
    expect((await f.store.read(f.article.path)).raw).toBe(original.raw);
  });
  it('does not revive a queued picker after a newer explicit navigation intent', async () => {
    const f = await fixture({ body: '==first words==' }),
      entered = gate(),
      release = gate();
    const blocked = f.probe.operation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = menu(f.view, 'Add highlight to notes…');
    const leaving = f.view.readingList();
    release.resolve();
    await blocked;
    await pending;
    await leaving;
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
  });
  it('captures and drains a sole-default native selection on normal close even after the native range disappears', async () => {
    const f = await fixture({ defaults: [0] });
    f.probe.surface.selectionValue = { quote: 'first words', before: 'Before ', after: ' after.' };
    const closing = f.view.onClose();
    f.probe.surface.selectionValue = undefined;
    await closing;
    expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual(['Nodes/Concept']);
    expect(await f.vault.read(f.targets[0])).toContain('> first words');
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
  });
  it('finishes a sole-default pending native selection before navigation without starting a picker', async () => {
    const f = await fixture({ defaults: [1] });
    f.probe.surface.selectionValue = { quote: 'first words', before: 'Before ', after: ' after.' };
    await f.view.readingList();
    expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual(['Nodes/Project']);
    expect(f.probe.snapshot).toBeUndefined();
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
  });
  it.each([{ defaults: [] }, { defaults: [0, 1] }])(
    'does not open a newly required picker after navigation intent (defaults=$defaults)',
    async ({ defaults }) => {
      const f = await fixture({ defaults });
      f.probe.surface.selectionValue = {
        quote: 'first words',
        before: 'Before ',
        after: ' after.',
      };
      await f.view.readingList();
      expect((await f.store.read(f.article.path)).body).toBe('Before first words after.');
      expect(mocks.highlightPicker).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'uses an incoming native paragraph only when explicitly requested, after bookmark restore (fragment=%s)',
    async (fragment) => {
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
      const restore = vi.spyOn(actual.ReadingSurface.prototype, 'restore'),
        reveal = vi.spyOn(actual.ReadingSurface.prototype, 'reveal');
      const f = await fixture({
        body: 'First saved paragraph.\n\nExplicit destination paragraph. ^native-existing',
      });
      f.vault.bytes.set(
        f.article,
        patchProperties(await f.vault.read(f.article), { bookmark: 'First saved paragraph.' }),
      );
      restore.mockClear();
      reveal.mockClear();
      await f.view.setState(
        { file: f.article.path, ...(fragment ? { subpath: '#^native-existing' } : {}) },
        {} as any,
      );
      expect(restore).toHaveBeenCalledWith('First saved paragraph.');
      if (fragment) {
        expect(reveal).toHaveBeenCalledOnce();
        expect(reveal.mock.calls[0][0].dataset.readerParagraph).toBe('native-existing');
        expect(reveal.mock.invocationCallOrder[0]).toBeGreaterThan(
          restore.mock.invocationCallOrder[0],
        );
      } else expect(reveal).not.toHaveBeenCalled();
      expect(f.view.getState()).not.toHaveProperty('subpath');
      expect((await f.store.read(f.article.path)).properties).not.toHaveProperty('subpath');
    },
  );
  it('passes an existing native paragraph subpath through the public new-pane opener', async () => {
    const f = await fixture({ body: 'Destination paragraph. ^native-existing' });
    await openExistingNote(f.app, `${f.article.path}#^native-existing`, 'Nodes/Concept.md', true);
    expect(f.app.workspace.getLeaf).toHaveBeenCalledWith(true);
    expect(f.opened.openFile).toHaveBeenCalledWith(f.article, {
      active: true,
      eState: { subpath: '#^native-existing' },
    });
  });
  it('does not also capture or open a URL when its click ends a native selection', async () => {
    const f = await fixture({ body: '[first words](https://publisher.test/report)' });
    f.paint();
    f.probe.surface.selectionValue = { quote: 'first words', before: '', after: '' };
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    f.probe.surface.body.querySelector('a').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.confirmWebLink).not.toHaveBeenCalled();
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });
});
