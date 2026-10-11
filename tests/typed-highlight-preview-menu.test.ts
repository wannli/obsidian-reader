import { expect, it, vi } from 'vitest';
import { PreviewNativeUI } from '../preview/native-host';
import { BrowserStore } from '../preview/store';
import { DEFAULT_SETTINGS } from '../src/types';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import type { ReaderApp } from '../src/ui/app';
it('preview-native menu offers configured types, persists the node, and opens it with article context', async () => {
  const store = new BrowserStore('typed-preview-menu-test'), path = 'Reading/Inbox/Preview.md';
  await store.create(path, '---\ntype: article\n---\n==Ada Lovelace==');
  const repository = new ReaderRepository(store, DEFAULT_SETTINGS), controller = new ReaderController(repository, vi.fn(), DEFAULT_SETTINGS);
  const ui = new PreviewNativeUI(controller, () => ({} as ReaderApp), store);
  // Exercise actual menu actions without emulating native dialog geometry in jsdom.
  const dialog = document.createElement('dialog'); document.body.append(dialog);
  Object.assign(dialog, { close: () => {} });
  vi.spyOn(ui as unknown as { dialog(title: string): HTMLDialogElement }, 'dialog').mockReturnValue(dialog);
  const updated = vi.fn(), host = { openNote: vi.fn() };
  let close = () => {};
  try {
    const article = await repository.getArticle(path);
    close = ui.highlightMenu(document.body, article, article.highlights[0], controller, host, { x: 0, y: 0 }, updated);
    const person = [...dialog.querySelectorAll('button')].find(button => button.textContent === '🟡 person');
    expect(person).toBeDefined(); person!.click();
    await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
    expect(await store.read('Nodes/Ada Lovelace.md')).toBe('---\ntype: person\n---\n');
    close(); dialog.replaceChildren();
    const saved = await repository.getArticle(path);
    close = ui.highlightMenu(document.body, saved, saved.highlights[0], controller, host, { x: 0, y: 0 }, updated);
    const labels = [...dialog.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).not.toContain('Link'); expect(labels).not.toContain('Link to…');
    [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Open node')!.click();
    expect(host.openNote).toHaveBeenCalledWith('Nodes/Ada Lovelace', path);
  } finally { close(); ui.dispose(); dialog.remove(); await controller.shutdown(); localStorage.removeItem('typed-preview-menu-test'); vi.restoreAllMocks(); }
});
