import { afterEach, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({
  buttons: new Map<string, () => void>(),
  toggle: undefined as ((enabled: boolean) => void) | undefined,
  modal: undefined as { close(): void } | undefined,
  copy: [] as string[],
}));
vi.mock('obsidian', () => ({
  Notice: class {},
  PluginSettingTab: class {},
  Modal: class {
    contentEl = {
      empty() {
        ui.buttons.clear();
        ui.copy = [];
      },
      createEl(_tag: string, options: { text: string }) {
        ui.copy.push(options.text);
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
        setValue() {
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

it('does not expose Sync or run work for an already-stopped generation', () => {
  const lifetime = new AbortController();
  lifetime.abort();
  const refreshAll = vi.fn();
  showFeeds({} as any, {} as any, { refreshAll } as any, lifetime.signal);
  expect(ui.buttons.size).toBe(0);
  expect(refreshAll).not.toHaveBeenCalled();
});
