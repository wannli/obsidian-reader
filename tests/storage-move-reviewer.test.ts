import { mark } from './markdown-helpers';
import { readNoteRaw } from './markdown-helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS as BASE_SETTINGS } from '../src/types';
const DEFAULT_SETTINGS = BASE_SETTINGS;
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';

afterEach(() => vi.restoreAllMocks());
const dailyPath = 'Daily/reviewer.md';
const destination = (path: string) => 'Reading/Later/' + path.split('/').at(-1);
class MarkdownOnlyStore extends MemoryStore {
  override async list(): Promise<string[]> { return (await super.list()).filter(path => path.endsWith('.md')); }
}
async function highlighted(sourceLinks = '') {
  const store = new MarkdownOnlyStore({ [dailyPath]: '---\ncustom: keep\n---\n## Reading\n\nPersonal daily writing.\n' });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Reviewer safety', url: '', body: 'Source quote.\n\n' + sourceLinks });
  const saved = await mark(repo, article.path, {
    quote: 'Source quote.',
  });
  return { store, repo, article: saved, id: saved.highlights[0].id };
}
function watchWrites(store: MemoryStore) {
  const calls = [vi.spyOn(store, 'create'), vi.spyOn(store, 'process'), vi.spyOn(store, 'rename')];
  return () => { for (const call of calls) expect(call).not.toHaveBeenCalled(); };
}
describe('directory-relative source wikilinks with Markdown-only enumeration', () => {
  it.each(['![[./photo.png]]', '[[./photo.png|Photo]]', '![[%2e%2fphoto.png]]', '[[../missing#Heading|Missing]]'])(
    'refuses %s before any write or move journal', async link => {
      const { store, repo, article } = await highlighted(link);
      await store.create('Reading/Inbox/photo.png', 'Attachment bytes not returned by list().');
      expect(await store.exists('Reading/Inbox/photo.png')).toBe(true);
      expect(await store.list()).not.toContain('Reading/Inbox/photo.png');
      const before = store.snapshot(), noWrites = watchWrites(store);
      await expect(repo.setStatus(article.path, 'later')).rejects.toThrow('unresolved directory-relative source link');
      noWrites();
      expect(store.snapshot()).toEqual(before);
      expect(parseNote(await readNoteRaw(store, article.path)).doc.has('queueMove')).toBe(false);
      expect(await store.exists(destination(article.path))).toBe(false);
    },
  );

  it('permits resolved and unresolved relative links in unrelated notes without modifying them', async () => {
    const { store, repo, article } = await highlighted('[[Reference]]');
    await store.create('Notes/Other.md', '[[./Neighbour]] [[./missing]] ![[./photo.png]]\n');
    await store.create('Notes/Neighbour.md', 'An unrelated neighbour.\n');
    await store.create('Notes/photo.png', 'Other attachment bytes.');
    const before = store.snapshot(), moved = await repo.setStatus(article.path, 'later');
    expect(moved.path).toBe(destination(article.path));
    expect(moved.highlights).toEqual(article.highlights);
    expect(parseNote(await readNoteRaw(store, moved.path)).body).toBe(parseNote(before[article.path]).body);
    for (const path of ['Notes/Other.md', 'Notes/Neighbour.md', 'Notes/photo.png']) expect(await store.read(path)).toBe(before[path]);
    expect(await store.read(dailyPath)).toBe(before[dailyPath].replace(article.path.replace(/\.md$/, '') + '#^', moved.path.replace(/\.md$/, '') + '#^'));
    expect(await store.exists(article.path)).toBe(false);
    expect(parseNote(await readNoteRaw(store, moved.path)).doc.has('queueMove')).toBe(false);
  });
});

it('byte-preserving move keeps custom YAML anchor/alias semantics', async () => {
  const path = 'Reading/Inbox/Aliases.md';
  const raw = '---\ntype: article\ncustom: &prefs {rating: 5}\ncopy: *prefs\n---\n==Source words==\n';
  const store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const moved = await repo.setStatus(path, 'later');
  expect(await store.read(moved.path)).toBe(raw);
  expect(parseNote(await store.read(moved.path)).doc.toJS()).toMatchObject({ custom: { rating: 5 }, copy: { rating: 5 } });
});
