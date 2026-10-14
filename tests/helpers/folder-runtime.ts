import { vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  vaults: [] as any[],
  watchers: [] as any[],
  notices: [] as string[],
}));
vi.mock('obsidian', () => ({
  FileView: class {},
  MarkdownView: class {},
  TFile: class {},
  Platform: { isMobile: false },
  Notice: class {
    constructor(message: string) {
      runtime.notices.push(message);
    }
  },
  parseLinktext: (path: string) => ({ path }),
  Plugin: class {
    constructor(public app: any) {}
    data: any = {};
    factory: any;
    loadData = vi.fn(async () => this.data);
    saveData = vi.fn(async (data: any) => {
      this.data = data;
    });
    registerView(_type: string, factory: any) {
      this.factory = factory;
    }
    addRibbonIcon() {}
    addCommand() {}
    registerObsidianProtocolHandler() {}
    addSettingTab() {}
    registerEvent() {}
    registerDomEvent() {}
    registerInterval() {}
  },
}));
vi.mock('../../src/reader/view', () => ({
  READER_VIEW: 'reader',
  nativeLinkPath: (path: string) => path,
  ReaderView: class {
    file = undefined;
    stopped = false;
    constructor(
      public leaf: any,
      public host: any,
    ) {}
    getViewType() {
      return 'reader';
    }
    stopForUnload() {
      this.stopped = true;
    }
    readingList = vi.fn(async () => {});
    changed = vi.fn(async () => {});
    protects = () => false;
  },
}));
vi.mock('../../src/host/network', () => ({
  Network: class {
    stop = vi.fn();
  },
}));
vi.mock('../../src/host/settings', () => ({ ReaderSettings: class {}, showFeeds: vi.fn() }));
vi.mock('../../src/host/dialogs', () => ({ input: vi.fn() }));
vi.mock('../../src/host/ingestion', () => ({
  Ingestion: class {
    stop = vi.fn();
    acquire = vi.fn(async () => {});
    refreshAll = vi.fn(async () => {});
    constructor(
      public store: any,
      _notice: any,
      public network: any,
    ) {}
  },
}));
vi.mock('../../src/host/vault', () => ({
  ObsidianVault: class {
    drain = vi.fn(async () => {});
    constructor(
      public app: any,
      public active: () => boolean,
    ) {
      runtime.vaults.push(this);
    }
    file(path: string) {
      return this.app.notes.get(path)?.file;
    }
  },
  watchLibrary: vi.fn((plugin: any, store: any, changed: any) => {
    const stop = vi.fn();
    runtime.watchers.push({ stop, changed });
    for (const [path, note] of plugin.app.notes) store.catalog.update(path, note.properties);
    return stop;
  }),
}));
import ReaderPlugin from '../../src/main';
import { ReaderView } from '../../src/reader/view';
import { MarkdownView } from 'obsidian';

export async function runtimeFixture(data: unknown = {}) {
  runtime.vaults = [];
  runtime.watchers = [];
  runtime.notices = [];
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    body: { classList: { toggle: vi.fn(), remove: vi.fn() } },
  });
  vi.stubGlobal('window', { setInterval: vi.fn() });
  vi.stubGlobal('navigator', { onLine: true });
  let paged = '0';
  vi.stubGlobal('localStorage', {
    getItem: () => paged,
    setItem: (_key: string, value: string) => {
      paged = value;
    },
  });
  const leaves: any[] = [];
  const app: any = {
    notes: new Map(),
    workspace: {
      getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view.getViewType() === type),
      iterateAllLeaves: (visit: any) => leaves.forEach(visit),
      getActiveViewOfType: (type: any) =>
        leaves[0]?.view instanceof type ? leaves[0].view : undefined,
      on: vi.fn(),
      onLayoutReady: vi.fn(),
    },
    metadataCache: { on: vi.fn() },
  };
  const plugin: any = new ReaderPlugin(app, {} as any);
  plugin.data = data;
  await plugin.onload();
  const leaf = () => {
    const result: any = { view: { getViewType: () => 'empty' } };
    result.setViewState = vi.fn(async (state: any) => {
      result.view =
        state.type === 'reader' ? plugin.factory(result) : { getViewType: () => state.type };
    });
    leaves.push(result);
    return result;
  };
  app.workspace.getLeaf = () => leaf();
  const reader = leaf();
  reader.view = new ReaderView(reader, plugin.readerHost());
  const native = leaf();
  native.view = Object.assign(new MarkdownView(native), { getViewType: () => 'markdown' });
  return { plugin, app, reader, native, leaves, runtime, leaf };
}
