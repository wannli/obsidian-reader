// @vitest-environment node
import { afterAll, afterEach, expect, it, vi } from 'vitest';
const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));
const ui = vi.hoisted(() => ({ modal: undefined as any }));
vi.mock('obsidian', () => ({
  Platform: { isMobile: false },
  Notice: class {},
  PluginSettingTab: class {},
  Setting: class {},
  Modal: class {
    contentEl = document.createElement('div');
    modalEl = document.createElement('div');
    constructor() {
      this.modalEl.append(this.contentEl);
      ui.modal = this;
    }
    setTitle() {}
    onOpen() {}
    onClose() {}
    open() {
      document.body.append(this.modalEl);
      this.onOpen();
    }
    close() {
      this.onClose();
      this.modalEl.remove();
    }
  },
}));
vi.mock('../src/host/folder-picker', () => ({ FolderSuggest: class {} }));
import { showFeeds } from '../src/host/settings';
afterEach(() => {
  ui.modal?.close();
  document.body.replaceChildren();
});
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;
function fixture() {
  const feed = {
    path: 'Subscriptions/Example.md',
    title: 'Example',
    prefix: 'Example',
    url: 'https://example.test/feed',
    enabled: true,
  };
  const store = {
    catalog: { feeds: () => [feed] },
    vault: { file: () => ({}), read: async () => 'original bytes' },
  };
  const ingestion = {
    subscribe: vi.fn(async () => {}),
    editFeed: vi.fn(async () => {}),
    setFeed: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    refreshAll: vi.fn(async () => {}),
  };
  const app = { workspace: { openLinkText: vi.fn() } };
  showFeeds(app as any, store as any, ingestion as any, new AbortController().signal);
  return { ingestion, feed, app };
}
it('adds inline without opening another modal or implicitly syncing', async () => {
  const { ingestion } = fixture();
  const url = document.querySelector<HTMLInputElement>('input')!;
  url.value = 'https://example.test/feed';
  document
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(ingestion.subscribe).toHaveBeenCalledOnce());
  expect(document.querySelectorAll('.reader-feeds-modal')).toHaveLength(1);
  expect(ingestion.refreshAll).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input')!.value).toBe(''));
  button('Sync').click();
  await vi.waitFor(() => expect(ingestion.refreshAll).toHaveBeenCalledOnce());
});
it('edits title and prefix in place against the bytes that were displayed', async () => {
  const { ingestion, feed } = fixture();
  const details = document.querySelector('details')!;
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  await vi.waitFor(() => expect(button('Save')).toBeDefined());
  const inputs = details.querySelectorAll('input');
  inputs[0].value = 'New name';
  inputs[1].value = 'Short';
  inputs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() =>
    expect(ingestion.editFeed).toHaveBeenCalledWith(
      feed,
      { title: 'New name', prefix: 'Short' },
      'original bytes',
    ),
  );
  expect(ingestion.refreshAll).not.toHaveBeenCalled();
});
it('retains failed input and shows the error in the same modal', async () => {
  const { ingestion } = fixture();
  ingestion.subscribe.mockRejectedValue(new Error('Invalid feed'));
  document.querySelector<HTMLInputElement>('input')!.value = 'bad';
  document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[role=status]')?.textContent).toBe('Invalid feed'),
  );
  expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('bad');
  expect(document.querySelectorAll('.reader-feeds-modal')).toHaveLength(1);
});

it('keeps Enter on feed action buttons available to native keyboard activation', async () => {
  const { ingestion } = fixture();
  const details = document.querySelector('details')!;
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  await vi.waitFor(() => expect(button('Pause feed')).toBeDefined());
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  button('Pause feed').dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(ingestion.editFeed).not.toHaveBeenCalled();
  button('Pause feed').click();
  await vi.waitFor(() => expect(ingestion.setFeed).toHaveBeenCalledOnce());
});
