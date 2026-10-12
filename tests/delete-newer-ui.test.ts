import { afterEach, expect, it, vi } from 'vitest';
import { ReaderApp } from '../src/ui/app';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type Article } from '../src/types';
vi.mock('../src/ui/reader', () => ({ mountReader: (pane: HTMLElement, article: Article) => {
  const view = document.createElement('article'); view.textContent = article.body; pane.replaceChildren(view);
  return Object.assign(() => view.remove(), { setArticleEnd: (footer: HTMLElement) => view.append(footer) });
} }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); document.body.replaceChildren(); });
async function fixture() {
  const store = new MemoryStore(), repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
  const raw = '---\ntype: article\nurl: https://example.com\n---\n';
  const paths = ['260103 New', '260102 Current', '260101 Old'].map(name => `Reading/Stream/${name}.md`);
  for (const [index, path] of paths.entries()) await store.create(path, raw.replace('type: article', `type: article\npublished: 2026-01-0${3 - index}`));
  await store.create('Reading/Inbox/Other.md', raw);
  const controller = new ReaderController(repo, vi.fn(), { ...DEFAULT_SETTINGS }); controller.setActive(false);
  const root = document.createElement('div'); document.body.append(root);
  let answer!: (value: boolean) => void;
  const confirm = vi.fn(() => new Promise<boolean>(resolve => { answer = resolve; })), notify = vi.fn();
  const reader = new ReaderApp(root, controller, { openNote() {}, autoOpen: false, confirmTrash: confirm, notify });
  cleanup.push(async () => { await reader.destroy(); await controller.shutdown(); });
  await reader.refresh(); await reader.open(paths[1], { queue: 'feed' });
  const button = () => root.querySelector<HTMLButtonElement>('.r2-article-end-delete-newer')!;
  return { store, repo, paths, raw, reader, root, confirm, notify, button, answer: (value: boolean) => answer(value) };
}
it('deletes only preceding/newer Stream entries, keeps Reader open, excludes new arrivals and duplicate submits', async () => {
  const f = await fixture(); f.button().click(); f.button().click();
  await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledExactlyOnceWith(1, 0));
  await f.store.create('Reading/Stream/260104 Arrival.md', f.raw.replace('type: article', 'type: article\npublished: 2026-01-04'));
  f.answer(true); await vi.waitFor(() => expect(f.notify).toHaveBeenCalled());
  expect(await f.store.exists(f.paths[0])).toBe(false);
  for (const path of [f.paths[1], f.paths[2], 'Reading/Inbox/Other.md', 'Reading/Stream/260104 Arrival.md']) expect(await f.store.exists(path)).toBe(true);
  expect(f.reader.getArticle()?.path).toBe(f.paths[1]);
});
it('excludes tied, unknown and invalid dates despite shuffled storage order', async () => {
  const f = await fixture();
  const kept: string[] = [];
  for (const [name, date] of [['000 Tie', '2026-01-02'], ['ZZ Unknown', ''], ['001 Invalid', '2026-02-31'], ['ZZ Older', '2025-12-31']]) {
    const path = `Reading/Stream/${name}.md`; kept.push(path);
    await f.store.create(path, f.raw.replace('type: article', `type: article\npublished: ${date}`));
  }
  await f.reader.refresh(); f.button().click();
  await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledExactlyOnceWith(1, 0));
  f.answer(true); await vi.waitFor(() => expect(f.notify).toHaveBeenCalled());
  for (const path of kept) expect(await f.store.exists(path)).toBe(true);
});
it.each(['date', 'body', 'replacement'])('keeps candidates if current %s changes during confirmation', async change => {
  const f = await fixture(); f.button().click(); await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled());
  await f.store.process(f.paths[1], raw => change === 'date' ? raw.replace('2026-01-02', '2026-01-04') : change === 'body' ? raw + 'Comment' : f.raw);
  f.answer(true); await vi.waitFor(() => expect(f.notify).toHaveBeenCalled());
  expect(await f.store.exists(f.paths[0])).toBe(true);
});
it('rechecks the observed current bytes at native trash dispatch', async () => {
  const f = await fixture(), original = f.store.trash.bind(f.store);
  vi.spyOn(f.store, 'trash').mockImplementationOnce(async (...args) => {
    await f.store.process(f.paths[1], raw => raw + 'Edited during dispatch');
    await original(...args);
  });
  f.button().click(); await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled());
  f.answer(true); await vi.waitFor(() => expect(f.notify).toHaveBeenCalled());
  expect(await f.store.exists(f.paths[0])).toBe(true);
});
it('cancels without deleting and hides the control outside Stream', async () => {
  const f = await fixture(); f.button().click(); await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled());
  f.answer(false); await vi.waitFor(() => expect(f.button().disabled).toBe(false));
  expect(await f.store.exists(f.paths[0])).toBe(true);
  await f.reader.open('Reading/Inbox/Other.md', { queue: 'inbox' }); expect(f.button().hidden).toBe(true);
});
it.each(['navigation', 'edit', 'recreate'])('revalidates %s while confirming', async race => {
  const f = await fixture(); f.button().click(); await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled());
  if (race === 'navigation') await f.reader.open(f.paths[2], { queue: 'feed' });
  else if (race === 'edit') await f.store.process(f.paths[0], raw => raw + 'User comment');
  else await f.repo.articleDeleted(f.paths[0]);
  f.answer(true); await vi.waitFor(() => expect(f.notify).toHaveBeenCalled());
  expect(await f.store.exists(f.paths[0])).toBe(true);
  expect(f.notify.mock.calls[0][0]).toContain('Deleted 0; skipped 1');
});
