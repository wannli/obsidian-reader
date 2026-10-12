import { afterEach, expect, it, vi } from 'vitest';
import { ReaderApp } from '../src/ui/app';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';

// Only geometry is simulated: use the real Reader mount, persistence and storage.
const position = vi.hoisted(() => ({ marker: '' }));
vi.mock('../src/ui/scroll-position', () => ({ trackScrollPosition: () => ({
  getPosition: () => ({ ...position }), restorePosition() {}, dispose() {},
}) }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); document.body.replaceChildren(); vi.restoreAllMocks(); position.marker = ''; });
it.each([false, true])('pending own position save permits delete without accepting external edits (%s)', async external => {
  const store = new MemoryStore(), repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
  const first = await repo.createArticle({ title: 'First', body: 'One two three', status: 'inbox', url: '', extractor: 'manual' });
  const next = await repo.createArticle({ title: 'Second', body: 'Four five six', status: 'inbox', url: '', extractor: 'manual' });
  const controller = new ReaderController(repo, vi.fn(), { ...DEFAULT_SETTINGS }); controller.setActive(false);
  const root = document.createElement('div'); document.body.append(root);
  const reader = new ReaderApp(root, controller, { autoOpen: false, openNote() {}, shouldFocus: () => true });
  cleanup.push(async () => { await reader.destroy(); await controller.shutdown(); });
  await reader.refresh(); await reader.open(first.path);
  const original = repo.saveReadingPositionRevision.bind(repo), trash = vi.spyOn(store, 'trash');
  const save = vi.spyOn(repo, 'saveReadingPositionRevision').mockImplementation(async (...args) => {
    const saved = await original(...args);
    if (external) await store.process(first.path, raw => raw + '\nNew authored text');
    return saved;
  });
  position.marker = 'One two three';
  root.querySelector('.r2-reader-scroll')!.dispatchEvent(new Event('scroll'));
  root.querySelector<HTMLButtonElement>('.r2-article-end-delete')!.click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  if (external) {
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('.r2-article-end-delete')!.disabled).toBe(false));
    expect(trash).not.toHaveBeenCalled(); expect(reader.getArticle()?.path).toBe(first.path);
    expect(await store.read(first.path)).toContain('New authored text');
  } else {
    await vi.waitFor(() => expect(reader.getArticle()?.path).toBe(next.path));
    expect(trash).toHaveBeenCalledOnce();
    expect(trash.mock.calls[0][1].expectedContent).toContain('reading_position');
  }
});
