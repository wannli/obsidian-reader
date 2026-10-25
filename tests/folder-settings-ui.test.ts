import { beforeEach, expect, it, vi } from 'vitest';
import type { App, Plugin } from 'obsidian';
import { defaultFolders } from '../src/core/folders';
import { defaultStatusFolders } from '../src/core/status-folders';

const ui = vi.hoisted(() => ({
  settings: [] as any[],
  notices: [] as string[],
  picker: undefined as any,
}));
vi.mock('../src/host/dialogs', () => ({ input: vi.fn() }));
vi.mock('obsidian', () => {
  class Text {
    value = '';
    change: (value: string) => void = () => {};
    setValue(value: string) {
      this.value = value;
      return this;
    }
    onChange(change: (value: string) => void) {
      this.change = change;
      return this;
    }
  }
  class Toggle {
    value = false;
    change: (value: boolean) => unknown = () => {};
    setValue(value: boolean) {
      this.value = value;
      return this;
    }
    onChange(change: (value: boolean) => unknown) {
      this.change = change;
      return this;
    }
  }
  class Button {
    text = '';
    disabled = false;
    click: () => unknown = () => {};
    setButtonText(text: string) {
      this.text = text;
      return this;
    }
    setDisabled(disabled: boolean) {
      this.disabled = disabled;
      return this;
    }
    setCta() {
      return this;
    }
    onClick(click: () => unknown) {
      this.click = click;
      return this;
    }
  }
  return {
    Modal: class {},
    TFolder: class {},
    Notice: class {
      constructor(message: string) {
        ui.notices.push(message);
      }
    },
    FuzzySuggestModal: class {
      constructor(public app: unknown) {
        ui.picker = this;
      }
      setPlaceholder() {}
      open() {}
    },
    PluginSettingTab: class {
      containerEl = {
        empty: () => {
          ui.settings = [];
        },
        createEl: () => {},
      };
      constructor(public app: unknown) {}
    },
    Setting: class {
      name = '';
      settingEl = { style: { display: '' } };
      input?: Text;
      toggle?: Toggle;
      buttons: Button[] = [];
      constructor() {
        ui.settings.push(this);
      }
      setName(name: string) {
        this.name = name;
        return this;
      }
      setDesc() {
        return this;
      }
      addText(add: (control: Text) => void) {
        this.input = new Text();
        add(this.input);
        return this;
      }
      addButton(add: (control: Button) => void) {
        const button = new Button();
        this.buttons.push(button);
        add(button);
        return this;
      }
      addToggle(add: (control: Toggle) => void) {
        this.toggle = new Toggle();
        add(this.toggle);
        return this;
      }
    },
  };
});
import { ReaderSettings } from '../src/host/settings';

beforeEach(() => {
  ui.settings = [];
  ui.notices = [];
  ui.picker = undefined;
});
const row = (name: string) => ui.settings.find((setting) => setting.name === name);

it('keeps device-local pagination without an article navigation setting or losing staged folder edits', async () => {
  const savePaged = vi.fn();
  const saveFolders = vi.fn(async () => {});
  const settings = new ReaderSettings(
    {} as App,
    {} as Plugin,
    defaultFolders,
    false,
    saveFolders,
    savePaged,
  );
  settings.display();
  expect(row('Show article navigation in paged mode')).toBeUndefined();
  row('Feed subscriptions').input.change('Staged/Subscriptions');
  row('Boox / e-ink pagination (this device)').toggle.change(true);
  expect(savePaged).toHaveBeenCalledExactlyOnceWith(true);
  await row('Apply folder locations').buttons[0].click();
  expect(saveFolders).toHaveBeenCalledExactlyOnceWith({
    ...defaultFolders,
    feeds: 'Staged/Subscriptions',
  });
  settings.display();
  expect(row('Boox / e-ink pagination (this device)').toggle.value).toBe(true);
  expect(row('Show article navigation in paged mode')).toBeUndefined();
});

it('shows only the feed subscription creation destination and preserves the legacy article setting', async () => {
  const save = vi.fn(async () => {});
  const legacyFolders = { articles: 'Legacy/Articles', feeds: defaultFolders.feeds };
  const settings = new ReaderSettings({} as App, {} as Plugin, legacyFolders, false, save, vi.fn());
  settings.display();
  expect(ui.settings.filter((setting) => setting.input)).toHaveLength(5);
  expect(row('Articles')).toBeUndefined();
  row('Feed subscriptions').buttons[0].click();
  ui.picker.onChooseItem({ path: 'Subscriptions' });
  expect(row('Feed subscriptions').input.value).toBe('Subscriptions');
  expect(save).not.toHaveBeenCalled();
  await row('Apply folder locations').buttons[0].click();
  expect(save).toHaveBeenCalledExactlyOnceWith({
    articles: legacyFolders.articles,
    feeds: 'Subscriptions',
  });
  settings.display();
  expect(row('Feed subscriptions').input.value).toBe('Subscriptions');
  expect(row('Articles')).toBeUndefined();
});

it('rejects an unsafe path before persistence and does not update committed settings', async () => {
  const save = vi.fn(async () => {});
  const settings = new ReaderSettings(
    {} as App,
    {} as Plugin,
    defaultFolders,
    false,
    save,
    vi.fn(),
  );
  settings.display();
  row('Feed subscriptions').input.change('../Unsafe');
  await row('Apply folder locations').buttons[0].click();
  expect(save).not.toHaveBeenCalled();
  expect(ui.notices.at(-1)).toMatch(/vault-relative/);
  settings.display();
  expect(row('Feed subscriptions').input.value).toBe(defaultFolders.feeds);
});

it('retains prior settings on persistence failure and disables duplicate apply while saving', async () => {
  let reject!: (error: Error) => void;
  const save = vi.fn(
    () =>
      new Promise<void>((_, no) => {
        reject = no;
      }),
  );
  const settings = new ReaderSettings(
    {} as App,
    {} as Plugin,
    defaultFolders,
    false,
    save,
    vi.fn(),
  );
  settings.display();
  row('Feed subscriptions').input.change('Subscriptions');
  const button = row('Apply folder locations').buttons[0];
  const pending = button.click();
  expect(button.disabled).toBe(true);
  reject(new Error('Disk full'));
  await pending;
  expect(button.disabled).toBe(false);
  expect(ui.notices.at(-1)).toBe('Disk full');
  settings.display();
  expect(row('Feed subscriptions').input.value).toBe(defaultFolders.feeds);
});

it.each(['Reading/Articles', 'Reading/Articles/Feeds', ''])(
  'allows shared, nested and root feed subscription destinations: %j',
  async (feeds) => {
    const save = vi.fn(async () => {});
    const settings = new ReaderSettings(
      {} as App,
      {} as Plugin,
      defaultFolders,
      false,
      save,
      vi.fn(),
    );
    settings.display();
    row('Feed subscriptions').input.change(feeds);
    await row('Apply folder locations').buttons[0].click();
    expect(save).toHaveBeenCalledExactlyOnceWith({ articles: defaultFolders.articles, feeds });
  },
);

it('shows the four default queue destinations and applies a staged mapping as one group', async () => {
  const save = vi.fn(async () => {});
  const settings = new ReaderSettings(
    {} as App,
    {} as Plugin,
    defaultFolders,
    false,
    vi.fn(),
    vi.fn(),
    {},
    save,
  );
  settings.display();
  for (const [status, folder] of Object.entries(defaultStatusFolders))
    expect(row(`${status} folder`).input.value).toBe(folder);
  row('later folder').input.change('Library/Later');
  row('archive folder').buttons[0].click();
  ui.picker.onChooseItem({ path: 'Library/Treasury' });
  expect(save).not.toHaveBeenCalled();
  await row('Apply status folders').buttons[0].click();
  expect(save).toHaveBeenCalledExactlyOnceWith({
    ...defaultStatusFolders,
    later: 'Library/Later',
    archive: 'Library/Treasury',
  });
});

it.each([
  ['../Outside', /vault-relative/],
  ['', /vault root/],
  ['Templates/Articles', /Templates/],
  ['Reading/Inbox/Child', /overlap/],
  ['Reading/Stream', /overlap/],
])('rejects invalid queue folder %j before saving', async (path, error) => {
  const save = vi.fn(async () => {});
  const settings = new ReaderSettings(
    {} as App,
    {} as Plugin,
    defaultFolders,
    false,
    vi.fn(),
    vi.fn(),
    {},
    save,
  );
  settings.display();
  row('later folder').input.change(path);
  await row('Apply status folders').buttons[0].click();
  expect(save).not.toHaveBeenCalled();
  expect(ui.notices.at(-1)).toMatch(error);
});
