// Shared Node/jsdom Obsidian fixture. Mock registration and state stay together.
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { Platform, TFile, type App, type Command, type WorkspaceLeaf } from 'obsidian';
import { ArticleStore, type VaultPort } from '../../src/core/store';
import { defaultFolders, type ReaderFolders } from '../../src/core/folders';
import { createDocument, patchProperties, readDocument } from '../../src/core/document';
import { changePassage, passages } from '../../src/core/annotations';
import { hostPassage, paragraphAnchors } from '../../src/core/hosted-highlights';
import { articleTopicPill, type ArticleTopic } from '../../src/reader/topic-pills';
import { ArticleAnalysis } from '../../src/reader/article-analysis';
import { ReaderView } from '../../src/reader/view';
import ReaderPlugin from '../../src/main';
import type { NodesApi, NodeResult } from '../../src/host/nodes';
import { MemoryVault } from './memory-vault';

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

vi.mock('../../src/host/dialogs', () => ({
  choose: mocks.choose,
  chooseTopics: mocks.topics,
  input: mocks.input,
  confirmWebLink: mocks.confirmWebLink,
}));

vi.mock('../../src/host/highlight-picker', () => ({ chooseHighlightHost: mocks.highlightPicker }));

const defaultHighlightPath = 'Nodes/Default.md';

vi.mock('../../src/host/topic-filter-dialog', () => ({ chooseTopicFilter: vi.fn() }));

vi.mock('../../src/host/settings', () => ({ ReaderSettings: class {}, showFeeds: vi.fn() }));

vi.mock('../../src/host/vault', () => ({
  ObsidianVault: class {
    constructor(app: any) {
      return app.__vault;
    }
  },
  watchLibrary: () => () => {},
}));

vi.mock('../../src/host/ingestion', () => ({
  Ingestion: class {
    acquire = vi.fn(async () => {});
    refreshAll = vi.fn(async () => {});
    stop = vi.fn();
  },
}));

vi.mock('../../src/reader/surface', () => ({
  ReadingSurface: class {
    analysis = new ArticleAnalysis();
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
    moveByPage = vi.fn();
    jumpTo = vi.fn();
    reveal = vi.fn();
    highlightFeedback = vi.fn(() => vi.fn());
    dispose = vi.fn(() => this.analysis.clear());
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
export {
  dom,
  mocks,
  defaultHighlightPath,
  fixtureViews,
  hostFixture,
  enableHighlightHost,
  enableTypedTopics,
  pluginFixture,
  actionName,
  passageButton,
  passageLabels,
  expectNoPassagePopup,
  expectedPassageActions,
  expectedHosted,
  expectedRemovedHosted,
  rememberDefaultHost,
  menu,
};
