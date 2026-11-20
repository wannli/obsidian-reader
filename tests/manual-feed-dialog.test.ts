import { afterEach, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({
  buttons: new Map<string, () => void>(),
  toggle: undefined as ((enabled: boolean) => void) | undefined,
  modal: undefined as { close(): void } | undefined,
  copy: [] as string[],
  alerts: [] as { textContent: string }[],
  toggleValue: false,
}));
vi.mock('obsidian', () => ({
  Notice: class {},
  PluginSettingTab: class {},
  Modal: class {
    contentEl = {
      empty() {
        ui.buttons.clear();
        ui.copy = [];
        ui.alerts = [];
      },
      createEl(_tag: string, options: { text?: string; attr?: { role?: string } }) {
        if (options.text) ui.copy.push(options.text);
        const element = { textContent: '' };
        if (options.attr?.role === 'alert') ui.alerts.push(element);
        return element;
      },
    };
    constructor() {
      ui.modal = this;
    }
    setTitle() {}
    onOpen() {}
    onClose() {}
    open() {
      this.onOpen();
    }
    close() {
      this.onClose();
    }
  },
  Setting: class {
    setName() {
      return this;
    }
    setDesc() {
      return this;
    }
    addButton(configure: (button: any) => void) {
      let label = '';
      configure({
        setButtonText(text: string) {
          label = text;
          return this;
        },
        setWarning() {
          return this;
        },
        onClick(callback: () => void) {
          ui.buttons.set(label, callback);
          return this;
        },
      });
      return this;
    }
    addToggle(configure: (toggle: any) => void) {
      configure({
        setValue(value: boolean) {
          ui.toggleValue = value;
          return this;
        },
        onChange(callback: (enabled: boolean) => void) {
          ui.toggle = callback;
          return this;
        },
      });
      return this;
    }
  },
}));
vi.mock('../src/host/folder-picker', () => ({ FolderPicker: class {} }));
vi.mock('../src/host/dialogs', () => ({ input: vi.fn() }));
import { showFeeds } from '../src/host/settings';
import { input } from '../src/host/dialogs';

afterEach(() => {
  ui.modal?.close();
  ui.modal = undefined;
  ui.toggle = undefined;
  ui.buttons.clear();
  vi.clearAllMocks();
});

it('only the explicit Sync button refreshes: opening, Add and enablement do not', async () => {
  const feed = {
    path: 'Subscriptions/Example.md',
    title: 'Example',
    url: 'https://example.com/feed',
    enabled: true,
  };
  const store = { catalog: { feeds: () => [feed] } };
  const ingestion = {
    subscribe: vi.fn(async () => {}),
    setFeed: vi.fn(async () => {}),
    refreshAll: vi.fn(async () => {}),
  };
  const lifetime = new AbortController();
  showFeeds({} as any, store as any, ingestion as any, lifetime.signal);
  expect(ingestion.refreshAll).not.toHaveBeenCalled();
  expect(ui.copy.join(' ')).toContain('Adding saves a subscription without fetching');
  ui.buttons.get('Add feed')!();
  const add = vi.mocked(input).mock.calls[0][3];
  await add(feed.url, lifetime.signal);
  expect(ingestion.subscribe).toHaveBeenCalledExactlyOnceWith(feed.url, lifetime.signal);
  ui.toggle!(false);
  await Promise.resolve();
  expect(ingestion.setFeed).toHaveBeenCalledExactlyOnceWith(feed, false);
  expect(ingestion.refreshAll).not.toHaveBeenCalled();
  ui.buttons.get('Sync')!();
  await Promise.resolve();
  expect(ingestion.refreshAll).toHaveBeenCalledOnce();
  lifetime.abort();
  expect(ui.buttons.size).toBe(0);
});

it('reconciles a failed toggle from fresh bytes and exposes a local error', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const feed = { path: 'Feeds/A.md', title: 'A', url: 'https://example.com/feed', enabled: true };
  const file = { path: feed.path, stat: { mtime: 1, size: 40 } };
  const update = vi.fn((_path, properties) => {
    feed.enabled = properties.enabled;
  });
  const store = {
    catalog: { feeds: () => [feed], feed: () => feed, update },
    vault: { file: () => file, read: async () => '---\ntype: feed\nenabled: true\n---\n' },
  };
  let reject!: (error: Error) => void;
  const setFeed = vi.fn(
    () =>
      new Promise<void>((_, no) => {
        reject = no;
      }),
  );
  showFeeds({} as any, store as any, { setFeed } as any, new AbortController().signal);
  ui.toggle!(false);
  ui.toggle!(false);
  expect(setFeed).toHaveBeenCalledOnce();
  reject(new Error('Disk full'));
  await vi.waitFor(() =>
    expect(ui.alerts[0]?.textContent).toContain('Change subscription: Disk full'),
  );
  expect(update).toHaveBeenCalledOnce();
  expect(ui.toggleValue).toBe(true);
});

function gatedReconciliation() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const path = 'Feeds/A.md';
  let feed = { path, title: 'A', url: 'https://example.com/feed', enabled: true };
  const file = { path, stat: { mtime: 1, size: 40 } };
  let currentFile = file;
  let release!: (raw: string) => void;
  let entered!: () => void;
  const reading = new Promise<string>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const update = vi.fn((_path, properties) => {
    feed = { ...feed, ...properties };
  });
  const store = {
    catalog: { feeds: () => [feed], feed: () => feed, update },
    vault: {
      file: () => currentFile,
      read: vi.fn(() => {
        entered();
        return reading;
      }),
    },
  };
  const lifetime = new AbortController();
  const setFeed = vi.fn(async () => {
    throw new Error('Disk full');
  });
  showFeeds({} as any, store as any, { setFeed } as any, lifetime.signal);
  ui.toggle!(false);
  return {
    path,
    file,
    store,
    lifetime,
    started,
    reading,
    release,
    replaceFile: () => {
      currentFile = { ...file };
    },
    currentFeed: () => feed,
  };
}

it.each(['revision and catalog', 'catalog only', 'mtime', 'size', 'path', 'identity'] as const)(
  'does not publish reconciliation superseded by %s',
  async (change) => {
    const f = gatedReconciliation();
    await f.started;
    if (change === 'revision and catalog' || change === 'mtime') f.file.stat.mtime++;
    if (change === 'size') f.file.stat.size++;
    if (change === 'path') f.file.path = 'Feeds/Renamed.md';
    if (change === 'identity') f.replaceFile();
    if (change === 'revision and catalog' || change === 'catalog only')
      f.store.catalog.update(f.path, { title: 'Newer external edit', enabled: true });
    const current = f.currentFeed();
    const updates = f.store.catalog.update.mock.calls.length;
    f.release('---\ntype: feed\nenabled: false\n---\n');
    await vi.waitFor(() => expect(ui.alerts[0]?.textContent).toContain('could not be verified'));
    expect(f.store.catalog.update).toHaveBeenCalledTimes(updates);
    expect(f.currentFeed()).toBe(current);
    expect(f.currentFeed().enabled).toBe(true);
    expect(ui.toggleValue).toBe(true);
  },
);

it.each(['abort', 'close'] as const)(
  'does not publish or render reconciliation after %s',
  async (ending) => {
    const f = gatedReconciliation();
    await f.started;
    if (ending === 'abort') f.lifetime.abort();
    else ui.modal!.close();
    f.release('---\ntype: feed\nenabled: false\n---\n');
    await f.reading;
    await Promise.resolve();
    expect(f.store.catalog.update).not.toHaveBeenCalled();
    expect(ui.alerts).toEqual([]);
    expect(ui.buttons.size).toBe(0);
  },
);

it('keeps unsubscribe uncertainty and mixed Sync failures visible without retrying', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const feed = { path: 'Feeds/A.md', title: 'A', enabled: true };
  const store = { catalog: { feeds: () => [feed] } };
  const unsubscribe = vi.fn(async () => {
    throw new Error('Trash completion uncertain');
  });
  const refreshAll = vi.fn(async () => [
    'A: network failed; could not save the subscription error',
  ]);
  showFeeds(
    {} as any,
    store as any,
    { unsubscribe, refreshAll } as any,
    new AbortController().signal,
  );
  ui.buttons.get('Unsubscribe')!();
  await vi.waitFor(() =>
    expect(
      ui.alerts.some((alert) => alert.textContent.includes('Trash completion uncertain')),
    ).toBe(true),
  );
  ui.buttons.get('Sync')!();
  await vi.waitFor(() =>
    expect(
      ui.alerts.some((alert) =>
        alert.textContent.includes('Some articles may already have been imported'),
      ),
    ).toBe(true),
  );
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(refreshAll).toHaveBeenCalledOnce();
});

it('does not expose Sync or run work for an already-stopped generation', () => {
  const lifetime = new AbortController();
  lifetime.abort();
  const refreshAll = vi.fn();
  showFeeds({} as any, {} as any, { refreshAll } as any, lifetime.signal);
  expect(ui.buttons.size).toBe(0);
  expect(refreshAll).not.toHaveBeenCalled();
});
