// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { Catalog } from '../src/core/catalog';
import { articleInfo } from '../src/core/model';
import { createDocument } from '../src/core/document';
import { TopicScanner } from '../src/reader/topic-scan';
import { ReaderView } from '../src/reader/view';

const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));
const mocks = vi.hoisted(() => ({ filter: vi.fn(), topics: vi.fn(), highlightHost: vi.fn() }));
vi.mock('../src/host/topic-filter-dialog', () => ({ chooseTopicFilter: mocks.filter }));
vi.mock('../src/host/highlight-picker', () => ({ chooseHighlightHost: mocks.highlightHost }));
vi.mock('../src/host/dialogs', () => ({
  choose: vi.fn(),
  chooseTopics: mocks.topics,
  confirmWebLink: vi.fn(),
}));
vi.mock('../src/reader/surface', () => ({
  ReadingSurface: class {
    title: HTMLElement;
    body: HTMLElement;
    constructor(parent: HTMLElement) {
      const flow = parent.createDiv({ cls: 'reader-flow' });
      this.title = flow.createEl('h1', { cls: 'reader-article-title' });
      this.body = flow.createDiv({ cls: 'reader-article-body' });
    }
    setTitle(title: string) {
      this.title.textContent = title;
    }
    setTopics = vi.fn();
    displayedBody = '';
    setBody(body: string) {
      this.displayedBody = body;
      this.body.textContent = body;
    }
    selection() {
      return null;
    }
    restore() {}
    flush() {}
    dispose() {}
    canPage() {
      return false;
    }
  },
}));
vi.mock('obsidian', () => ({
  ItemView: class {
    app: any;
    contentEl = document.createElement('div');
    constructor(public leaf: any) {
      this.app = leaf.app;
      document.body.append(this.contentEl);
    }
  },
  Notice: class {},
  Menu: class {},
  TFile: class {},
  setIcon: () => {},
  setTooltip: () => {},
  parseLinktext: (path: string) => ({ path }),
}));

beforeEach(() => {
  document.body.replaceChildren();
  mocks.filter.mockReset();
  mocks.topics.mockReset();
  mocks.highlightHost.mockReset().mockResolvedValue(null);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  const proto = HTMLElement.prototype as any;
  proto.empty = function () {
    this.replaceChildren();
  };
  proto.addClass = function (...names: string[]) {
    this.classList.add(...names);
  };
  proto.removeClass = function (...names: string[]) {
    this.classList.remove(...names);
  };
  proto.createEl = function (tag: string, options: any = {}) {
    const el = document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {}))
      el.setAttribute(key, String(value));
    this.append(el);
    return el;
  };
  proto.createDiv = function (options: any) {
    return this.createEl('div', options);
  };
});
const tick = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};
function fixture() {
  const catalog = new Catalog();
  const files = new Map<string, any>();
  const cache = new Map<any, any>();
  const read = vi.fn(async (file: any) => file.raw);
  const app: any = {
    vault: {
      getMarkdownFiles: () => [...files.values()],
      getAbstractFileByPath: (path: string) => files.get(path),
    },
    metadataCache: {
      getFileCache: (file: any) => cache.get(file),
      getFirstLinkpathDest: (path: string) => files.get(path) ?? files.get(`${path}.md`),
    },
  };
  const host: any = {
    app,
    store: {
      catalog,
      annotate: vi.fn(async () => undefined),
      collectHighlight: vi.fn(async () => undefined),
      setRelatedNodes: vi.fn(async (source: unknown) => source),
      vault: { file: (path: string) => files.get(path), read },
      read: vi.fn(async (path: string) => {
        const file = files.get(path);
        const { properties, body } = (await import('../src/core/document')).readDocument(file.raw);
        return { path, file, properties, body };
      }),
    },
    signal: new AbortController().signal,
    ingestion: { acquire: vi.fn() },
    capture: vi.fn(),
  };
  const view = new ReaderView({ app } as any, host);
  const probe = view as any;
  probe.syncPresentation = () => {
    probe.surface?.setTitle?.(probe.articleLabel());
  };
  probe.prepareToLeave = async () => {};
  const add = (path: string, body: string, properties: any = {}) => {
    properties = { type: 'article', status: 'inbox', ...properties };
    const raw = createDocument(properties, body);
    const file = {
      path,
      basename: path.split('/').pop()!.replace(/\.md$/, ''),
      stat: { mtime: 1, size: raw.length },
      raw,
    };
    Object.setPrototypeOf(file, TFile.prototype);
    files.set(path, file);
    cache.set(file, { frontmatter: properties });
    catalog.update(path, properties);
    return file;
  };
  const rows = () =>
    [...view.contentEl.querySelectorAll('.reader-list-title')].map((row) => row.textContent);
  return { view, probe, host, add, read, files, cache, rows };
}

// This suite supplies a minimal Surface double; tap gestures and the full article
// toolbar are covered with real DOM surfaces in view-lifecycle/tap-highlighter.
vi.mock('../src/reader/tap-highlighter', () => ({
  TapHighlighter: class {
    active = false;
    reset() {}
    setUndoAvailable() {}
    dispose() {}
  },
}));

describe('topic-filter view integration', () => {
  it('matches only current queue, resolves aliases and links, and never acquires or writes', async () => {
    const f = fixture();
    f.add('Topics/Climate.md', '', { type: 'topic', aliases: ['global warming'] });
    f.add('Reading/Inbox/Linked.md', 'unrelated', { topics: ['[[Topics/Climate]]'] });
    f.add('Reading/Inbox/Body.md', 'About GLOBAL **WARMING** today.');
    f.add('Reading/Inbox/No.md', 'warmingness');
    f.add('Reading/Later/Other queue.md', 'global warming', { status: 'later' });
    const originalBytes = [...f.files].map(([path, file]) => [path, file.raw]);
    expect(f.host.app.plugins).toBeUndefined();
    f.probe.topicFilter = { label: 'Climate', path: 'Topics/Climate.md', terms: ['obsolete'] };
    f.view.showList();
    await tick();
    expect(f.rows()).toEqual(['Body', 'Linked']);
    expect(f.read.mock.calls.map(([file]) => file.path).sort()).toEqual([
      'Reading/Inbox/Body.md',
      'Reading/Inbox/No.md',
    ]);
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
    expect(f.host.capture).not.toHaveBeenCalled();
    expect(f.host.store.annotate).not.toHaveBeenCalled();
    expect(f.host.store.collectHighlight).not.toHaveBeenCalled();
    expect(f.host.store.setRelatedNodes).not.toHaveBeenCalled();
    expect(mocks.highlightHost).not.toHaveBeenCalled();
    expect(mocks.topics).not.toHaveBeenCalled();
    expect([...f.files].map(([path, file]) => [path, file.raw])).toEqual(originalBytes);
    const filter = f.view.contentEl.querySelector('[aria-label="Filter by topic"]')!;
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    expect(filter.classList.contains('reader-filter-active')).toBe(true);
    expect(f.view.getDisplayText()).toBe('Reading list: Climate');
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: Climate',
    );
  });

  it('keeps existing-content filtering provider-independent during a Fileclass reload', async () => {
    const f = fixture();
    f.add('Reading/Inbox/Existing.md', 'Previously saved climate text.');
    const getPlugin = vi.fn(() => {
      throw new Error('Fileclass is reloading');
    });
    f.host.app.plugins = { getPlugin };
    f.probe.topicFilter = { label: 'climate', terms: ['climate'] };
    const before = [...f.files].map(([path, file]) => [path, file.raw]);
    f.view.showList();
    await tick();
    expect(f.rows()).toEqual(['Existing']);
    expect(getPlugin).not.toHaveBeenCalled();
    expect(mocks.highlightHost).not.toHaveBeenCalled();
    expect(f.host.store.annotate).not.toHaveBeenCalled();
    expect(f.host.store.collectHighlight).not.toHaveBeenCalled();
    expect(f.host.store.setRelatedNodes).not.toHaveBeenCalled();
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
    expect(f.host.capture).not.toHaveBeenCalled();
    expect(mocks.filter).not.toHaveBeenCalled();
    expect(mocks.topics).not.toHaveBeenCalled();
    expect([...f.files].map(([path, file]) => [path, file.raw])).toEqual(before);
  });

  it('supports free text, all-result navigation, pagination, clearing and retained queue filters', async () => {
    const f = fixture();
    for (let i = 0; i < 55; i++)
      f.add(`Reading/Inbox/Article ${String(i).padStart(2, '0')}.md`, 'sea level');
    f.add('Reading/Later/Later.md', 'sea level', { status: 'later' });
    mocks.filter.mockResolvedValue({ label: 'sea level', terms: ['sea level'] });
    f.view.showList();
    f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Filter by topic"]')!.click();
    await tick();
    expect(mocks.filter).toHaveBeenCalledOnce();
    expect(f.rows()).toHaveLength(50);
    expect(f.view.contentEl.querySelectorAll('.reader-list-heading')).toHaveLength(1);
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: sea level',
    );
    (f.view.contentEl.querySelector('[aria-label="Show more"]') as HTMLButtonElement).click();
    expect(f.rows()).toHaveLength(55);
    expect(f.view.contentEl.querySelectorAll('.reader-list-heading')).toHaveLength(1);
    f.probe.operation = (fn: () => unknown) => fn();
    const open = vi.spyOn(f.probe, 'openArticleNow').mockResolvedValue(undefined);
    await f.view.openArticle('Reading/Inbox/Article 00.md', true);
    expect((open.mock.calls[0][1] as { paths: string[] }).paths).toHaveLength(55);
    f.view.showList('Later');
    await tick();
    expect(f.rows()).toEqual(['Later']);
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: sea level',
    );
    (f.view.contentEl.querySelector('[aria-label="Filter by topic"]') as HTMLButtonElement).click();
    expect(f.probe.topicFilter).toBeUndefined();
    expect(mocks.filter).toHaveBeenCalledOnce();
    expect(f.view.getDisplayText()).toBe('Reading list');
    expect(f.view.contentEl.querySelector('.reader-list-heading')).toBeNull();
    expect(
      f.view.contentEl
        .querySelector('[aria-label="Filter by topic"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
    expect(f.view.contentEl.querySelector('.reader-topic-filter-state')).toBeNull();
  });

  it('shows one compact context with filtered row entry and next/previous after path changes', async () => {
    const f = fixture();
    f.add('Reading/Inbox/A.md', 'alpha');
    const second = f.add('Reading/Inbox/B.md', 'alpha');
    f.probe.topicFilter = { label: 'alpha <script>', terms: ['alpha'] };
    f.view.showList();
    await tick();
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: alpha <script>',
    );
    expect(f.view.contentEl.querySelector('script')).toBeNull();
    f.view.contentEl.querySelector<HTMLButtonElement>('.reader-list-item')!.click();
    await tick();
    const context = () => f.view.contentEl.querySelector('.reader-article-context');
    expect(context()?.textContent).toBe('Reading list: alpha <script>');
    expect(context()?.tagName).toBe('DIV');
    expect(f.view.contentEl.querySelectorAll('.reader-article-title')).toHaveLength(1);
    expect(f.view.contentEl.querySelector('script')).toBeNull();
    // Simulate a status-folder relocation after promotion; browsing paths follow identity.
    f.files.delete(second.path);
    second.path = 'Reading/Later/B.md';
    f.files.set(second.path, second);
    f.host.store.catalog.rename('Reading/Inbox/B.md', second.path, {
      type: 'article',
      status: 'later',
    });
    f.probe.readingQueue.rename('Reading/Inbox/B.md', second.path);
    await f.view.navigate(1);
    expect(f.probe.snapshot.path).toBe(second.path);
    expect(context()?.textContent).toBe('Reading list: alpha <script>');
    await f.view.navigate(-1);
    expect(f.probe.snapshot.path).toBe('Reading/Inbox/A.md');
    expect(context()?.textContent).toBe('Reading list: alpha <script>');
    await f.view.readingList();
    await tick();
    expect(context()).toBeNull();
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: alpha <script>',
    );
  });

  it('retains filtered article origin and List route when direct entry cannot leave', async () => {
    const f = fixture();
    f.add('Reading/Inbox/A.md', 'alpha');
    f.add('Reading/Inbox/Outside.md', 'other');
    f.probe.topicFilter = { label: 'alpha', terms: ['alpha'] };
    f.view.showList();
    await tick();
    f.view.contentEl.querySelector<HTMLButtonElement>('.reader-list-item')!.click();
    await tick();
    const before = f.probe.readingQueue;
    f.probe.prepareToLeave = vi.fn().mockRejectedValueOnce(new Error('Cannot save selection'));
    await expect(f.view.openArticle('Reading/Inbox/Outside.md')).rejects.toThrow(
      'Cannot save selection',
    );
    expect(f.probe.snapshot.path).toBe('Reading/Inbox/A.md');
    expect(f.probe.topicFilter.label).toBe('alpha');
    expect(f.probe.filteredOrigin).toBe(true);
    expect(f.probe.readingQueue).toBe(before);
    expect(f.view.contentEl.querySelector('.reader-article-context')?.textContent).toBe(
      'Reading list: alpha',
    );
    await f.view.readingList();
    await tick();
    expect(f.rows()).toEqual(['A']);
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: alpha',
    );
  });

  it('keeps the heading and final paged row reachable until filter clearance', async () => {
    const f = fixture();
    for (let i = 0; i < 101; i++)
      f.add(`Reading/Inbox/Article ${String(i).padStart(3, '0')}.md`, 'river');
    f.host.paged = true;
    f.probe.topicFilter = { label: 'river', terms: ['river'] };
    f.view.showList();
    await tick();
    for (const expected of [100, 101]) {
      f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Show more"]')!.click();
      expect(f.rows()).toHaveLength(expected);
      expect(f.view.contentEl.querySelectorAll('.reader-list-heading')).toHaveLength(1);
    }
    const last = f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-list-item')[100];
    expect(last.textContent).toBe('Article 100');
    last.click();
    await tick();
    expect(f.view.contentEl.querySelector('.reader-article-context')?.textContent).toBe(
      'Reading list: river',
    );
    await f.view.readingList();
    await tick();
    f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Filter by topic"]')!.click();
    expect(f.view.contentEl.querySelector('.reader-list-heading')).toBeNull();
    expect(f.view.contentEl.querySelector('.reader-article-context')).toBeNull();
  });

  it('does not assign filtered origin to direct article entry, including with a live filter', async () => {
    const f = fixture();
    f.add('Reading/Inbox/A.md', 'alpha');
    f.add('Reading/Inbox/Outside.md', 'other');
    f.probe.topicFilter = { label: 'alpha', terms: ['alpha'] };
    f.view.showList();
    await tick();
    await f.view.openArticle('Reading/Inbox/Outside.md');
    expect(f.view.contentEl.querySelector('.reader-article-context')).toBeNull();
    expect(f.probe.topicFilter).toBeUndefined();
    expect(f.view.contentEl.querySelectorAll('.reader-article-title')).toHaveLength(1);
    await f.view.readingList();
    expect(f.view.contentEl.querySelector('.reader-list-heading')).toBeNull();
  });

  it('keeps a heading during zero-result scans and scan failures', async () => {
    const f = fixture();
    f.add('Reading/Inbox/A.md', 'nothing');
    f.probe.topicFilter = { label: 'missing', terms: ['missing'] };
    f.view.showList();
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: missing',
    );
    await tick();
    expect(f.rows()).toEqual([]);
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: missing',
    );
    vi.spyOn(f.probe.topicScanner, 'scan').mockRejectedValueOnce(new Error('unavailable'));
    f.view.showList();
    await tick();
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: missing',
    );
    expect(f.view.contentEl.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('clears immediately during an unfinished scan without reopening the picker', async () => {
    const f = fixture();
    const file = f.add('Reading/Inbox/A.md', 'alpha');
    let release!: (raw: string) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.probe.topicFilter = { label: 'alpha', terms: ['alpha'] };
    f.view.showList();
    await tick();
    const scan = f.probe.topicScan;
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: alpha',
    );
    f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Filter by topic"]')!.click();
    expect(scan.signal.aborted).toBe(true);
    expect(f.rows()).toEqual(['A']);
    expect(f.view.getDisplayText()).toBe('Reading list');
    expect(mocks.filter).not.toHaveBeenCalled();
    release(file.raw);
    await tick();
    expect(f.rows()).toEqual(['A']);
    expect(f.probe.topicFilter).toBeUndefined();
  });

  it('does not retain old aliases when selected topic disappears; direct entry clears filtered context', async () => {
    const f = fixture();
    f.add('Reading/Inbox/Match.md', 'old alias');
    f.probe.topicFilter = { label: 'Gone', path: 'Topics/Gone.md', terms: ['old alias'] };
    f.view.showList();
    await tick();
    expect(f.rows()).toEqual([]);
    expect(f.view.getDisplayText()).toBe('Reading list: Gone (unavailable)');
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: Gone (unavailable)',
    );
    await f.view.openArticle('Reading/Inbox/Match.md');
    expect(f.probe.topicFilter).toBeUndefined();
    expect(f.probe.readingQueue.current).toBe('Reading/Inbox/Match.md');
    expect(f.view.contentEl.querySelector('.reader-article-context')).toBeNull();
  });

  it('aborts superseded scans and never publishes old results', async () => {
    const f = fixture();
    f.add('Reading/Inbox/A.md', 'alpha');
    let release!: (value: string) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.probe.topicFilter = { label: 'alpha', terms: ['alpha'] };
    f.view.showList();
    await tick();
    f.probe.topicFilter = { label: 'beta', terms: ['beta'] };
    f.view.showList();
    release(createDocument({ type: 'article' }, 'alpha'));
    await tick();
    expect(f.rows()).toEqual([]);
    expect(f.view.getDisplayText()).toBe('Reading list: beta');
    expect(f.view.contentEl.querySelector('.reader-list-heading')?.textContent).toBe(
      'Reading list: beta',
    );
  });

  it('refreshes body-only edits and current aliases; follows selected topic renames', async () => {
    const f = fixture();
    const topic = f.add('Topics/Old.md', '', { type: 'topic', aliases: ['before'] });
    const article = f.add('Reading/Inbox/A.md', 'after');
    f.probe.topicFilter = { label: 'Old', path: topic.path, terms: ['before'] };
    f.view.showList();
    await tick();
    expect(f.rows()).toEqual([]);
    f.cache.set(topic, { frontmatter: { type: 'topic', aliases: ['after'] } });
    await f.view.changed({ path: topic.path, metadataChanged: false });
    await tick();
    expect(f.rows()).toEqual(['A']);
    article.raw = createDocument({ type: 'article', status: 'inbox' }, 'different');
    article.stat.mtime++;
    await f.view.changed({ path: article.path, metadataChanged: false });
    await tick();
    expect(f.rows()).toEqual([]);
    f.files.delete(topic.path);
    topic.path = 'Topics/New.md';
    topic.basename = 'New';
    f.files.set(topic.path, topic);
    await f.view.changed({
      path: topic.path,
      previousPath: 'Topics/Old.md',
      metadataChanged: true,
    });
    await tick();
    expect(f.probe.topicFilter.path).toBe(topic.path);
    expect(f.view.getDisplayText()).toBe('Reading list: New');
  });

  it('refreshes active filtered results behind a focused picker and remains fresh after Cancel', async () => {
    const f = fixture();
    const article = f.add('Reading/Inbox/A.md', 'before');
    f.probe.topicFilter = { label: 'after', terms: ['after'] };
    f.view.showList();
    await tick();
    let cancel!: (value: null) => void;
    mocks.filter.mockImplementation(
      () =>
        new Promise((resolve) => {
          cancel = resolve;
        }),
    );
    const picking = f.probe.selectTopicFilter();
    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    article.raw = createDocument({ type: 'article', status: 'inbox' }, 'after');
    article.stat.mtime++;
    await f.view.changed({ path: article.path, metadataChanged: false });
    await tick();
    expect(f.rows()).toEqual(['A']);
    expect(mocks.filter.mock.calls[0][3].aborted).toBe(false);
    cancel(null);
    await picking;
    expect(f.rows()).toEqual(['A']);
    expect(f.view.contentEl.textContent).not.toContain('Filtering articles…');
  });

  it('preserves Related notes without a separate article filter banner', () => {
    const f = fixture();
    const file = f.add('Reading/Inbox/A.md', 'body');
    f.probe.snapshot = { file, path: file.path, body: 'body', properties: { type: 'article' } };
    f.probe.surface = { canPage: () => false, setTopics: vi.fn() };
    f.probe.actions = document.createElement('nav');
    f.view.contentEl.append(f.probe.actions);
    f.probe.topicFilter = { label: 'body', terms: ['body'] };
    const topics = vi.spyOn(f.probe, 'topics').mockResolvedValue(undefined);
    f.probe.controls();
    (f.view.contentEl.querySelector('[aria-label="Related notes"]') as HTMLButtonElement).click();
    expect(topics).toHaveBeenCalledOnce();
    expect(f.view.contentEl.querySelector('[aria-label="Clear topic filter"]')).toBeNull();
    expect(f.view.contentEl.querySelector('.reader-topic-filter-state')).toBeNull();
    expect(f.view.getDisplayText()).toBe('Reader: A');
    expect(f.probe.actions.querySelectorAll('button')).toHaveLength(7);
  });

  it('uses the staged Related notes multiselect and routes an empty Apply through setRelatedNodes', async () => {
    const f = fixture();
    const topic = f.add('Topics/Old.md', 'typed note', { type: 'topic' });
    const article = f.add('Reading/Inbox/A.md', 'body', { topics: ['[[Topics/Old.md]]'] });
    const node = { path: topic.path, title: 'Old', type: 'topic', classes: ['topic'], aliases: [] };
    const api = {
      version: 2,
      listTypes: vi.fn(() => [{ type: 'topic', label: 'Topic' }]),
      searchNodes: vi.fn(() => [node]),
      getNode: vi.fn((path: string) => (path === topic.path ? node : null)),
      createNode: vi.fn(async () => null),
      createNodeForLink: vi.fn(async () => null),
    };
    f.host.app.plugins = { getPlugin: () => ({ api }) };
    await f.view.openArticle(article.path);
    let apply!: (choice: { kind: 'existing-many'; nodes: never[] }) => void;
    mocks.highlightHost.mockImplementation(
      () =>
        new Promise((resolve) => {
          apply = resolve;
        }),
    );
    const pending = f.probe.topics();
    await tick();
    expect(mocks.highlightHost).toHaveBeenCalledOnce();
    expect(mocks.highlightHost).toHaveBeenCalledWith(
      f.host.app,
      api,
      expect.objectContaining({
        title: 'Related notes',
        multiple: true,
        selectedPaths: [topic.path],
        minSelection: 0,
        actionLabel: 'Apply',
        allowCreate: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(f.host.store.setRelatedNodes).not.toHaveBeenCalled();
    expect(f.host.store.annotate).not.toHaveBeenCalled();
    apply({ kind: 'existing-many', nodes: [] });
    await pending;
    expect(f.host.store.setRelatedNodes).toHaveBeenCalledOnce();
    expect(f.host.store.setRelatedNodes).toHaveBeenCalledWith(
      expect.objectContaining({ file: article }),
      [],
      [topic.path],
      expect.any(Function),
    );
    expect(f.host.store.annotate).not.toHaveBeenCalled();
    expect(f.host.store.collectHighlight).not.toHaveBeenCalled();
    expect(api.createNodeForLink).not.toHaveBeenCalled();
    expect(mocks.topics).not.toHaveBeenCalled();
    expect(mocks.filter).not.toHaveBeenCalled();
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
  });
});

describe('bounded topic scanner', () => {
  it('keeps occupied reads bounded across cancelled replacement scans', async () => {
    const scanner = new TopicScanner();
    const articles = ['a', 'b', 'c'].map((path) =>
      articleInfo(path, { type: 'article', status: 'inbox' })!,
    );
    const files = new Map(
      articles.map((a) => [a.path, { path: a.path, stat: { mtime: 1, size: 1 } }]),
    );
    let active = 0,
      maximum = 0;
    const releases: (() => void)[] = [];
    const read = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return 'match';
    });
    const options = (signal: AbortSignal) => ({
      signal,
      file: (path: string) => files.get(path),
      read,
      metadataMatch: () => false,
      bodyMatch: () => true,
    });
    const first = new AbortController();
    const second = new AbortController();
    const p1 = scanner.scan(articles, options(first.signal));
    await tick();
    first.abort();
    const p2 = scanner.scan(articles, options(second.signal));
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    releases.splice(0).forEach((release) => release());
    await tick();
    expect(read).toHaveBeenCalledTimes(4);
    second.abort();
    releases.splice(0).forEach((release) => release());
    await Promise.all([p1, p2]);
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it('retains only the newest pending scan and settles discarded requests before active reads finish', async () => {
    const scanner = new TopicScanner();
    const article = articleInfo('a', { type: 'article' })!;
    const file = { path: 'a', stat: { mtime: 1, size: 1 } };
    let release!: () => void;
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('body');
        }),
    );
    const first = new AbortController();
    const options = (signal: AbortSignal) => ({
      signal,
      file: () => file,
      read,
      metadataMatch: () => false,
      bodyMatch: () => true,
    });
    const active = scanner.scan([article], options(first.signal));
    await tick();
    first.abort();
    const pending = Array.from({ length: 100 }, () =>
      scanner.scan(Array(10_000).fill(article), {
        ...options(new AbortController().signal),
        metadataMatch: () => true,
      }),
    );
    const settled = vi.fn();
    void Promise.all(pending.slice(0, -1)).then(settled);
    await tick();
    expect(settled).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect((scanner as any).pending).toBeDefined();
    release();
    await active;
    const latest = await pending.at(-1)!;
    expect(latest.paths).toHaveLength(10_000);
    await tick();
    expect((scanner as any).pending).toBeUndefined();
  });

  it('reports unreadable and stale files without claiming matching or writing', async () => {
    const scanner = new TopicScanner();
    const articles = ['a', 'b'].map((path) => articleInfo(path, { type: 'article' })!);
    const files = new Map(
      articles.map((a) => [a.path, { path: a.path, stat: { mtime: 1, size: 1 } }]),
    );
    const result = await scanner.scan(articles, {
      signal: new AbortController().signal,
      file: (path) => files.get(path),
      read: async (file) => {
        if (file.path === 'a') throw new Error('unreadable');
        file.stat.mtime++;
        return 'match';
      },
      metadataMatch: () => false,
      bodyMatch: () => true,
    });
    expect(result).toEqual({ paths: [], uncertain: 2 });
  });
});
