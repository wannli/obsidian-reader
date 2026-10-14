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

it('stages five independent picker values and applies one whole group', async () => {
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
  expect(ui.settings.filter((setting) => setting.input)).toHaveLength(5);
  row('Inbox').input.change('Capture');
  row('Stream').input.change('Disposable');
  row('Later').input.change('Plans');
  row('Treasury').input.change('Kept');
  row('Feed subscriptions').buttons[0].click();
  ui.picker.onChooseItem({ path: 'Subscriptions' });
  expect(row('Feed subscriptions').input.value).toBe('Subscriptions');
  expect(save).not.toHaveBeenCalled();
  await row('Apply folder locations').buttons[0].click();
  expect(save).toHaveBeenCalledExactlyOnceWith({
    inbox: 'Capture',
    stream: 'Disposable',
    later: 'Plans',
    treasury: 'Kept',
    feeds: 'Subscriptions',
  });
  settings.display();
  expect(row('Inbox').input.value).toBe('Capture');
});

it('rejects a late overlap before persistence and does not update committed settings', async () => {
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
  row('Inbox').input.change('Capture');
  row('Feed subscriptions').input.change('Capture/Feeds');
  await row('Apply folder locations').buttons[0].click();
  expect(save).not.toHaveBeenCalled();
  expect(ui.notices.at(-1)).toMatch(/overlap/);
  settings.display();
  expect(row('Inbox').input.value).toBe(defaultFolders.inbox);
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
  row('Inbox').input.change('Capture');
  const button = row('Apply folder locations').buttons[0];
  const pending = button.click();
  expect(button.disabled).toBe(true);
  reject(new Error('Disk full'));
  await pending;
  expect(button.disabled).toBe(false);
  expect(ui.notices.at(-1)).toBe('Disk full');
  settings.display();
  expect(row('Inbox').input.value).toBe(defaultFolders.inbox);
});
