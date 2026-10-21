// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownView, TFile, type App, type PluginManifest } from 'obsidian';
import ReaderPlugin from '../src/main';
import { ReaderView } from '../src/reader/view';
import { createDocument } from '../src/core/document';
import { gate, MemoryVault } from './helpers/memory-vault';

// Obsidian ships declarations only. Keep server-side mock resolution while
// installing a local DOM, as in the existing lifecycle integration suite.
const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));
const hooks = vi.hoisted(() => ({
  disposers: [] as (() => void)[],
  processors: [] as ((element: HTMLElement, context: { sourcePath: string }) => void)[],
}));
vi.mock('obsidian', () => {
  class FileView {
    file?: unknown;
  }
  class MarkdownView extends FileView {
    containerEl = document.createElement('article');
    constructor(public leaf: unknown) {
      super();
      document.body.append(this.containerEl);
    }
    getEphemeralState() {
      return {};
    }
    getState() {
      return {};
    }
  }
  class TFile {
    get extension() {
      return 'md';
    }
  }
  class Plugin {
    constructor(public app: unknown) {}
    async loadData() {
      return {};
    }
    registerEvent() {}
    registerView() {}
    addRibbonIcon() {}
    addCommand() {}
    addSettingTab() {}
    registerObsidianProtocolHandler() {}
    registerInterval(id: number) {
      window.clearInterval(id);
    }
    registerDomEvent(
      target: EventTarget,
      type: string,
      callback: EventListener,
      options?: boolean | AddEventListenerOptions,
    ) {
      target.addEventListener(type, callback, options);
      hooks.disposers.push(() => target.removeEventListener(type, callback, options));
    }
    registerMarkdownPostProcessor(
      callback: (element: HTMLElement, context: { sourcePath: string }) => void,
    ) {
      hooks.processors.push(callback);
    }
  }
  return {
    FileView,
    MarkdownView,
    TFile,
    Plugin,
    Notice: class {},
    Platform: { isMobile: false },
    parseLinktext: vi.fn(),
  };
});
vi.mock('../src/reader/view', () => ({
  READER_VIEW: 'obsidian-reader',
  nativeLinkPath: vi.fn(),
  ReaderView: class {
    file?: unknown;
    constructor(public leaf: unknown) {}
    async prepareMarkdown() {}
    stopForUnload() {}
  },
}));
vi.mock('../src/host/vault', () => ({
  ObsidianVault: class {
    constructor(app: { memory: MemoryVault }) {
      return app.memory;
    }
  },
  watchLibrary: () => () => {},
}));
vi.mock('../src/host/network', () => ({
  Network: class {
    stop() {}
  },
}));
vi.mock('../src/host/ingestion', () => ({
  Ingestion: class {
    stop() {}
  },
}));
vi.mock('../src/host/dialogs', () => ({ input: vi.fn(), confirmArticleReplacement: vi.fn() }));
vi.mock('../src/host/settings', () => ({ ReaderSettings: class {}, showFeeds: vi.fn() }));

const plugins: ReaderPlugin[] = [];
afterEach(() => {
  plugins.splice(0).forEach((plugin) => plugin.onunload());
  hooks.disposers.splice(0).forEach((dispose) => dispose());
  hooks.processors.length = 0;
  vi.restoreAllMocks();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});
const settle = async () => {
  for (let at = 0; at < 8; at++) await Promise.resolve();
};

async function fixture() {
  const memory = new MemoryVault();
  const events = new Map<string, ((...args: unknown[]) => void)[]>();
  const metadataEvents = new Map<string, ((...args: unknown[]) => void)[]>();
  const listen = (map: typeof events) => (name: string, callback: (...args: unknown[]) => void) => {
    map.set(name, [...(map.get(name) ?? []), callback]);
    return {};
  };
  const emit = (map: typeof events, name: string, ...args: unknown[]) => {
    for (const callback of map.get(name) ?? []) callback(...args);
  };
  async function note(path: string, type = 'article') {
    const raw = createDocument(
      { type, bookmark: 'saved destination position' },
      'Original words. ^paragraph',
    );
    const file = await memory.create(path, raw);
    Object.setPrototypeOf(file, TFile.prototype);
    Object.assign(file, { stat: { mtime: 1, ctime: 1, size: raw.length } });
    return file as TFile;
  }
  const article = await note('Reading/Later/Decision rules.md');
  const source = await note('Concepts/Trust.md', 'concept');
  const other = await note('Reading/Later/Other.md');
  const panes: ReturnType<typeof pane>[] = [];
  let active: ReturnType<typeof pane>;
  function pane(file: TFile) {
    const leaf = { view: undefined as unknown, setViewState: vi.fn() };
    const native = new MarkdownView(leaf as never);
    const editor = {
      getValue: vi.fn(() => memory.bytes.get(native.file!)!),
      getSelection: vi.fn(() => ''),
      hasFocus: () => false,
    };
    Object.assign(native, { file, editor });
    leaf.view = native;
    leaf.setViewState.mockImplementation(
      async (state: { type: string; state: { file: string } }) => {
        if (state.type === 'obsidian-reader') {
          const reader = new ReaderView(leaf as never, {} as never);
          Object.assign(reader, { file: memory.file(state.state.file) });
          leaf.view = reader;
        } else if (state.type === 'markdown') leaf.view = native;
      },
    );
    return { leaf, native, editor };
  }
  active = pane(source);
  panes.push(active);
  const origin = active;
  const resolve = vi.fn((path: string, sourcePath: string) => {
    const folder = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
    return (
      memory.file(path) ?? memory.file(`${path}.md`) ?? memory.file(`${folder}${path}.md`) ?? null
    );
  });
  const app = {
    memory,
    workspace: {
      on: listen(events),
      onLayoutReady() {},
      getMostRecentLeaf: () => active.leaf,
      getActiveViewOfType: (constructor: new (...args: never[]) => unknown) =>
        active.leaf.view instanceof constructor ? active.leaf.view : null,
      getLeavesOfType: (type: string) =>
        panes
          .filter((entry) =>
            type === 'markdown'
              ? entry.leaf.view instanceof MarkdownView
              : entry.leaf.view instanceof ReaderView,
          )
          .map((entry) => entry.leaf),
      iterateAllLeaves: (callback: (leaf: unknown) => void) =>
        panes.forEach((entry) => callback(entry.leaf)),
    },
    metadataCache: { on: listen(metadataEvents), getFirstLinkpathDest: resolve },
  };
  const plugin = new ReaderPlugin(app as unknown as App, {} as PluginManifest);
  plugins.push(plugin);
  await plugin.onload();
  const workspace = (name: string, ...args: unknown[]) => emit(events, name, ...args);
  const metadata = (name: string, ...args: unknown[]) => emit(metadataEvents, name, ...args);
  const activate = (entry = origin, file = article) => {
    active = entry;
    entry.leaf.view = entry.native;
    entry.native.file = file;
  };
  const addPane = (file = article) => {
    const entry = pane(file);
    panes.push(entry);
    return entry;
  };
  const anchor = (href: string, context: string | null = source.path, entry = origin) => {
    const root = document.createElement('div');
    const link = document.createElement('a');
    link.className = 'internal-link';
    link.setAttribute('data-href', href);
    link.textContent = 'Article title';
    root.append(link);
    entry.native.containerEl.append(root);
    if (context !== null)
      hooks.processors.forEach((processor) => processor(root, { sourcePath: context }));
    return link;
  };
  const click = (link: HTMLElement, options: MouseEventInit = {}, open = true, entry = origin) => {
    if (open)
      link.addEventListener(
        'click',
        () => {
          activate(entry);
          workspace('file-open', article);
        },
        { once: true },
      );
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...options });
    link.dispatchEvent(event);
    return event;
  };
  const writes = vi.spyOn(memory, 'process');
  return {
    plugin,
    memory,
    article,
    source,
    other,
    origin,
    resolve,
    workspace,
    metadata,
    activate,
    addPane,
    anchor,
    click,
    writes,
  };
}

const readerState = (file: TFile, subpath?: string) => ({
  type: 'obsidian-reader',
  state: { file: file.path, ...(subpath ? { subpath } : {}) },
});

describe('public native paragraph intent in actual plugin routing', () => {
  it('observes a citation before native default, then forwards its fragment after normal host opening', async () => {
    const f = await fixture();
    const link = f.anchor('Reading/Later/Decision rules#^paragraph');
    link.addEventListener(
      'click',
      (event) => {
        expect(event.defaultPrevented).toBe(false);
        expect(f.resolve).toHaveBeenCalled();
        expect(f.origin.leaf.setViewState).not.toHaveBeenCalled();
      },
      { once: true },
    );
    const event = f.click(link);
    expect(event.defaultPrevented).toBe(false);
    await settle();
    expect(f.origin.native.getEphemeralState()).toEqual({});
    expect(f.origin.native.getState()).toEqual({});
    expect(f.origin.leaf.setViewState).toHaveBeenCalledExactlyOnceWith(
      readerState(f.article, '#^paragraph'),
    );
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('resolves an origin Properties anchor against its containing native pane, not the active pane', async () => {
    const f = await fixture();
    const elsewhere = f.addPane(f.other);
    f.activate(elsewhere, f.other);
    const link = f.anchor('Reading/Later/Decision rules#^paragraph', null);
    link.removeAttribute('data-href');
    link.setAttribute('href', 'Reading/Later/Decision rules#^paragraph');
    f.click(link);
    await settle();
    expect(f.resolve).toHaveBeenCalledWith('Reading/Later/Decision rules', f.source.path);
    expect(f.origin.leaf.setViewState).toHaveBeenCalledWith(readerState(f.article, '#^paragraph'));
    expect(elsewhere.leaf.setViewState).not.toHaveBeenCalled();
  });

  it('uses postprocessor sourcePath for an embedded citation and prefers native data-href', async () => {
    const f = await fixture();
    const link = f.anchor('Reading/Later/Decision%20rules#%5Eparagraph', 'Embedded/Source.md');
    link.setAttribute('href', 'app://obsidian.md/encoded-host-only');
    f.click(link);
    await settle();
    expect(f.resolve.mock.calls).toEqual([
      ['Reading/Later/Decision%20rules', 'Embedded/Source.md'],
      ['Reading/Later/Decision rules', 'Embedded/Source.md'],
    ]);
    expect(f.origin.leaf.setViewState).toHaveBeenCalledWith(readerState(f.article, '#^paragraph'));
  });

  it('leaves modifier/new-pane selection to the host and never requests focus or reuses the source pane', async () => {
    const f = await fixture();
    const next = f.addPane();
    const event = f.click(
      f.anchor('Reading/Later/Decision rules#^paragraph'),
      { ctrlKey: true, metaKey: true },
      true,
      next,
    );
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(next.leaf.setViewState).toHaveBeenCalledExactlyOnceWith(
      readerState(f.article, '#^paragraph'),
    );
    expect(f.origin.leaf.setViewState).not.toHaveBeenCalled();
  });

  it('does not activate or reroute a host-opened background pane', async () => {
    const f = await fixture();
    const next = f.addPane();
    f.click(f.anchor('Reading/Later/Decision rules#^paragraph'), { ctrlKey: true }, false);
    f.workspace('file-open', f.article);
    await settle();
    expect(next.leaf.setViewState).not.toHaveBeenCalled();
    expect(f.origin.leaf.setViewState).not.toHaveBeenCalled();
    f.activate(next);
    f.workspace('active-leaf-change', next.leaf);
    await settle();
    expect(next.leaf.setViewState).toHaveBeenCalledWith(readerState(f.article, '#^paragraph'));
  });

  it('retains a same-note paragraph intent from the rendered source, not the active filename', async () => {
    const f = await fixture();
    f.click(f.anchor('#^paragraph', f.article.path));
    await settle();
    expect(f.resolve).toHaveBeenCalledWith(f.article.path, f.article.path);
    expect(f.origin.leaf.setViewState).toHaveBeenCalledWith(readerState(f.article, '#^paragraph'));
  });

  it('allows the normal middle-button host open before routing its chosen pane', async () => {
    const f = await fixture();
    const next = f.addPane();
    const link = f.anchor('Reading/Later/Decision rules#^paragraph');
    link.addEventListener(
      'auxclick',
      () => {
        f.activate(next);
        f.workspace('file-open', f.article);
      },
      { once: true },
    );
    const event = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(next.leaf.setViewState).toHaveBeenCalledExactlyOnceWith(
      readerState(f.article, '#^paragraph'),
    );
    expect(f.origin.leaf.setViewState).not.toHaveBeenCalled();
  });

  it('normal entry still delegates bookmark resume without a subpath or file mutation', async () => {
    const f = await fixture();
    const raw = f.memory.bytes.get(f.article);
    f.activate();
    f.workspace('file-open', f.article);
    await settle();
    expect(f.origin.leaf.setViewState).toHaveBeenCalledExactlyOnceWith(readerState(f.article));
    expect(f.memory.bytes.get(f.article)).toBe(raw);
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('retains the hint through repeated file/active events until the final successful dispatch', async () => {
    const f = await fixture();
    const release = gate();
    const raw = f.memory.bytes.get(f.article)!;
    vi.spyOn(f.memory, 'read').mockImplementationOnce(async () => {
      await release.promise;
      return raw;
    });
    f.click(f.anchor('Reading/Later/Decision rules#^paragraph'));
    f.workspace('active-leaf-change', f.origin.leaf);
    await settle();
    release.resolve();
    await settle();
    expect(f.origin.leaf.setViewState).toHaveBeenCalledExactlyOnceWith(
      readerState(f.article, '#^paragraph'),
    );
  });

  it('does not dispatch duplicate transitions while a successful native replacement is still pending', async () => {
    const f = await fixture();
    const release = gate();
    const dispatch = f.origin.leaf.setViewState.getMockImplementation()!;
    f.origin.leaf.setViewState.mockImplementationOnce(async (state) => {
      await release.promise;
      await dispatch(state);
    });
    f.click(f.anchor('Reading/Later/Decision rules#^paragraph'));
    await settle();
    f.workspace('active-leaf-change', f.origin.leaf);
    f.metadata('changed', f.article);
    f.workspace('file-open', f.article);
    await settle();
    expect(f.origin.leaf.setViewState).toHaveBeenCalledExactlyOnceWith(
      readerState(f.article, '#^paragraph'),
    );
    release.resolve();
    await settle();
    f.activate();
    f.workspace('file-open', f.article);
    await settle();
    expect(f.origin.leaf.setViewState).toHaveBeenNthCalledWith(2, readerState(f.article));
  });

  it('does not consume on failed dispatch; consumes once after success', async () => {
    const f = await fixture();
    f.origin.leaf.setViewState.mockRejectedValueOnce(new Error('Leaf unavailable'));
    f.click(f.anchor('Reading/Later/Decision rules#^paragraph'));
    await settle();
    f.workspace('active-leaf-change', f.origin.leaf);
    await settle();
    expect(f.origin.leaf.setViewState).toHaveBeenNthCalledWith(
      1,
      readerState(f.article, '#^paragraph'),
    );
    expect(f.origin.leaf.setViewState).toHaveBeenNthCalledWith(
      2,
      readerState(f.article, '#^paragraph'),
    );
    f.activate();
    f.workspace('file-open', f.article);
    await settle();
    expect(f.origin.leaf.setViewState).toHaveBeenNthCalledWith(3, readerState(f.article));
  });

  it.each(['new-paragraph', 'unrelated-click', 'unload', 'replacement', 'rename'])(
    'rejects a delayed route after %s supersedes its intent',
    async (condition) => {
      const f = await fixture();
      const release = gate();
      const raw = f.memory.bytes.get(f.article)!;
      vi.spyOn(f.memory, 'read').mockImplementationOnce(async () => {
        await release.promise;
        return raw;
      });
      f.click(f.anchor('Reading/Later/Decision rules#^paragraph'));
      if (condition === 'new-paragraph') f.click(f.anchor('Reading/Later/Decision rules#^newer'));
      if (condition === 'unrelated-click')
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (condition === 'unload') f.plugin.onunload();
      if (condition === 'replacement') f.memory.files.set(f.article.path, { path: f.article.path });
      if (condition === 'rename') f.article.path = 'Reading/Later/Renamed.md';
      release.resolve();
      await settle();
      if (condition === 'new-paragraph')
        expect(f.origin.leaf.setViewState).toHaveBeenCalledExactlyOnceWith(
          readerState(f.article, '#^newer'),
        );
      else expect(f.origin.leaf.setViewState).not.toHaveBeenCalled();
    },
  );

  it('expires an in-flight hint instead of replaying it during a later ordinary open', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = await fixture();
    const release = gate();
    const raw = f.memory.bytes.get(f.article)!;
    vi.spyOn(f.memory, 'read').mockImplementationOnce(async () => {
      await release.promise;
      return raw;
    });
    f.click(f.anchor('Reading/Later/Decision rules#^paragraph'));
    now = 11_000;
    release.resolve();
    await settle();
    expect(f.origin.leaf.setViewState).not.toHaveBeenCalled();
    f.workspace('file-open', f.article);
    await settle();
    expect(f.origin.leaf.setViewState).toHaveBeenCalledExactlyOnceWith(readerState(f.article));
  });

  it('declines uncertain public ephemeral state without consuming a known hint', async () => {
    const f = await fixture();
    const state = vi.spyOn(f.origin.native, 'getEphemeralState').mockImplementationOnce(() => {
      throw new Error('Native view is loading');
    });
    f.click(f.anchor('Reading/Later/Decision rules#^paragraph'));
    await settle();
    expect(f.origin.leaf.setViewState).not.toHaveBeenCalled();
    state.mockReturnValue({});
    f.metadata('changed', f.article);
    await settle();
    expect(f.origin.leaf.setViewState).toHaveBeenCalledExactlyOnceWith(
      readerState(f.article, '#^paragraph'),
    );
  });

  it('never uses a known fragment to bypass dirty native editor bytes', async () => {
    const f = await fixture();
    f.origin.editor.getValue.mockReturnValue('Unsaved editor text');
    f.click(f.anchor('Reading/Later/Decision rules#^paragraph'));
    await settle();
    expect(f.origin.leaf.setViewState).not.toHaveBeenCalled();
    f.origin.editor.getValue.mockReturnValue(f.memory.bytes.get(f.article)!);
    f.metadata('changed', f.article);
    await settle();
    expect(f.origin.leaf.setViewState).toHaveBeenCalledWith(readerState(f.article, '#^paragraph'));
  });

  it.each(['native-selection', 'ephemeral-jump'])(
    'leaves unobservable Ctrl/programmatic paragraph navigation native after %s during a read',
    async (condition) => {
      const f = await fixture();
      const release = gate();
      const raw = f.memory.bytes.get(f.article)!;
      vi.spyOn(f.memory, 'read').mockImplementationOnce(async () => {
        await release.promise;
        return raw;
      });
      f.activate();
      f.workspace('file-open', f.article);
      if (condition === 'native-selection')
        f.origin.editor.getSelection.mockReturnValue('Native selected block');
      else
        vi.spyOn(f.origin.native, 'getEphemeralState').mockReturnValue({
          cursor: { line: 4, ch: 0 },
        });
      release.resolve();
      await settle();
      expect(f.origin.leaf.setViewState).not.toHaveBeenCalled();
      f.origin.editor.getSelection.mockReturnValue('');
      f.metadata('changed', f.article);
      f.workspace('active-leaf-change', f.origin.leaf);
      await settle();
      expect(f.origin.leaf.setViewState).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
    },
  );

  it('respects an already-active public native selection even when the DOM selection is collapsed', async () => {
    const f = await fixture();
    expect(document.getSelection()?.isCollapsed).not.toBe(false);
    f.origin.editor.getSelection.mockReturnValue('Native block');
    f.click(f.anchor('Reading/Later/Decision rules#^paragraph'));
    await settle();
    expect(f.origin.leaf.setViewState).not.toHaveBeenCalled();
  });

  it('preserves the explicit Open Markdown exemption even after a paragraph-link click', async () => {
    const f = await fixture();
    const reader = new ReaderView(f.origin.leaf as never, {} as never);
    Object.assign(reader, { file: f.article });
    f.origin.native.file = f.article;
    f.origin.leaf.view = reader;
    await f.plugin.edit(reader, f.article);
    f.click(f.anchor('Reading/Later/Decision rules#^paragraph'));
    f.metadata('changed', f.article);
    await settle();
    expect(f.origin.leaf.setViewState).toHaveBeenCalledExactlyOnceWith({
      type: 'markdown',
      state: { file: f.article.path, mode: 'source' },
      active: true,
    });
  });
});
