import { expect, it, vi } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
import { nativeStore } from './helpers/native-store';
const raw = '---\ntype: article\nurl: https://example.com/a\n---\n';
async function fixture() {
  const store = new MemoryStore(), repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
  const path = 'Reading/Stream/260101 Article.md';
  await store.create(path, raw);
  return { store, repo, path, candidate: { path, raw, generation: repo.articleGeneration(path) } };
}
it('previews counts and guards Stream-only scope', async () => {
  const f = await fixture();
  expect(await f.repo.previewStreamTrash([f.candidate])).toEqual({ candidates: [f.candidate], skipped: 0 });
  const inbox = 'Reading/Inbox/Article.md'; await f.store.create(inbox, raw);
  expect((await f.repo.previewStreamTrash([{ ...f.candidate, path: inbox }])).skipped).toBe(1);
});
it.each(['topics: [Test]', 'authors: [Person]', 'id: retired', 'custom: authored', 'reading_position: {version: 1}', 'reading_position: {marker: hello, authored: text}'])('keeps protected property %s', async property => {
  const f = await fixture(); const text = raw.replace('type: article', 'type: article\n' + property);
  await f.store.process(f.path, () => text);
  expect((await f.repo.previewStreamTrash([{ ...f.candidate, raw: text }])).skipped).toBe(1);
});
it.each(['Authored text', '==highlight==', '<!-- comment -->', '# My heading'])('preserves authored body %s', async body => {
  const f = await fixture(); const text = raw + body; await f.store.process(f.path, () => text);
  expect((await f.repo.previewStreamTrash([{ ...f.candidate, raw: text }])).skipped).toBe(1);
});
it('allows operational position but rechecks changed bytes, generation and backlinks', async () => {
  const f = await fixture(), text = raw.replace('type: article', 'type: article\nreading_position: hello');
  await f.store.process(f.path, () => text); const candidate = { ...f.candidate, raw: text };
  expect((await f.repo.previewStreamTrash([candidate])).skipped).toBe(0);
  await f.store.process(f.path, value => value + 'edit');
  expect(await f.repo.trashStreamCandidate(candidate, () => {})).toBe(false);
  await f.store.process(f.path, () => text); await f.repo.articleDeleted(f.path);
  expect(await f.repo.trashStreamCandidate(candidate, () => {})).toBe(false);
  const fresh = { ...candidate, generation: f.repo.articleGeneration(f.path) };
  await f.store.create('Journal.md', `[[${f.path}]]`);
  expect(await f.repo.trashStreamCandidate(fresh, () => {})).toBe(false);
});
it('uses native recoverable trash and its dispatch guard', async () => {
  const path = 'Reading/Stream/260101 Article.md', f = nativeStore({ [path]: raw });
  const repo = new ReaderRepository(f.store, { ...DEFAULT_SETTINGS }), candidate = { path, raw, generation: repo.articleGeneration(path) };
  const trash = vi.fn(async () => {}); Object.assign(f.vault, { trash });
  await expect(repo.trashStreamCandidate(candidate, () => { throw new Error('navigation changed'); })).rejects.toThrow('navigation changed');
  expect(trash).not.toHaveBeenCalled();
  expect(await repo.trashStreamCandidate(candidate, () => {})).toBe(true);
  expect(trash).toHaveBeenCalledWith(expect.objectContaining({ path }), false);
});
