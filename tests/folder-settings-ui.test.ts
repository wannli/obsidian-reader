import { beforeEach, expect, it, vi } from 'vitest';
import type { App, Plugin } from 'obsidian';
import { defaultFolders } from '../src/core/folders';

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
      input?: Text;
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
      addToggle(add: (control: Text) => void) {
        add(new Text());
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

it('stages two creation destination picker values and applies one whole group', async () => {
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
  expect(ui.settings.filter((setting) => setting.input)).toHaveLength(6);
  row('Articles').input.change('Capture');
  row('Feed subscriptions').buttons[0].click();
  ui.picker.onChooseItem({ path: 'Subscriptions' });
  expect(row('Feed subscriptions').input.value).toBe('Subscriptions');
  expect(save).not.toHaveBeenCalled();
  await row('Apply folder locations').buttons[0].click();
  expect(save).toHaveBeenCalledExactlyOnceWith({
    articles: 'Capture',
    feeds: 'Subscriptions',
  });
  settings.display();
  expect(row('Articles').input.value).toBe('Capture');
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
  row('Articles').input.change('Capture');
  row('Feed subscriptions').input.change('../Unsafe');
  await row('Apply folder locations').buttons[0].click();
  expect(save).not.toHaveBeenCalled();
  expect(ui.notices.at(-1)).toMatch(/vault-relative/);
  settings.display();
  expect(row('Articles').input.value).toBe(defaultFolders.articles);
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
  row('Articles').input.change('Capture');
  const button = row('Apply folder locations').buttons[0];
  const pending = button.click();
  expect(button.disabled).toBe(true);
  reject(new Error('Disk full'));
  await pending;
  expect(button.disabled).toBe(false);
  expect(ui.notices.at(-1)).toBe('Disk full');
  settings.display();
  expect(row('Articles').input.value).toBe(defaultFolders.articles);
});

it.each([
  { articles: 'Shared', feeds: 'Shared' },
  { articles: 'Shared', feeds: 'Shared/Feeds' },
  { articles: '', feeds: '' },
])('allows shared, nested and root creation destinations: %j', async (candidate) => {
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
  row('Articles').input.change(candidate.articles);
  row('Feed subscriptions').input.change(candidate.feeds);
  await row('Apply folder locations').buttons[0].click();
  expect(save).toHaveBeenCalledExactlyOnceWith(candidate);
});

it('stages four status mappings, with blank disabled and picker root explicit', async () => {
  const save = vi.fn(async () => {});
  const settings = new ReaderSettings(
    {} as App,
    {} as Plugin,
    defaultFolders,
    false,
    vi.fn(),
    vi.fn(),
    { later: 'Old', feed: '' },
    save,
  );
  settings.display();
  expect(row('feed folder').input.value).toBe('/');
  row('later folder').input.change('');
  row('inbox folder').buttons[0].click();
  ui.picker.onChooseItem({ path: '' });
  row('archive folder').input.change('Shared/Archive');
  expect(save).not.toHaveBeenCalled();
  await row('Apply status folders').buttons[0].click();
  expect(save).toHaveBeenCalledExactlyOnceWith({ inbox: '', feed: '', archive: 'Shared/Archive' });
});

it('rejects unsafe status mappings before saving', async () => {
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
  row('later folder').input.change('../Outside');
  await row('Apply status folders').buttons[0].click();
  expect(save).not.toHaveBeenCalled();
  expect(ui.notices.at(-1)).toMatch(/vault-relative/);
});
