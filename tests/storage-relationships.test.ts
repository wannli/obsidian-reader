import { afterEach, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';
import { parseNote } from '../src/storage/markdown';
import { nativeStore } from './helpers/native-store';
import { RelationshipDraft } from '../src/ui/relationship-draft';
import { ReaderController } from '../src/controller';
const path = 'Reading/Inbox/Article.md';
const body = '\n## Article\n\n==Words== and [[Existing]].\n\n## Comments\n\nUser notes.\n';
const raw = '---\ntype: article\nauthor: Legacy author\nbyline: Keep this\ncustom: [keep, all]\nreading_position: "Words"\n---\n' + body;
const person = '---\ntype: person\n---\n', topic = '---\ntype: topic\n---\n';
const staleNodeFence = /Node changed/;
afterEach(() => { vi.restoreAllMocks(); });
it('creates multiple author nodes only on explicit request and persists quoted links', async () => {
  const store = new MemoryStore({ [path]: raw });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.updateArticleAuthors(path, { create: ['Ada Lovelace', 'Charles Babbage'] });
  expect(article.authors).toEqual(['Nodes/Ada Lovelace.md', 'Nodes/Charles Babbage.md']);
  expect(await store.read('Nodes/Ada Lovelace.md')).toBe(person); expect(await store.read('Nodes/Charles Babbage.md')).toBe(person);
  const saved = await store.read(path), note = parseNote(saved);
  expect(saved).toMatch(/authors: \[\s*"\[\[Nodes\/Ada Lovelace\]\]", "\[\[Nodes\/Charles Babbage\]\]"\s*\]/);
  expect(saved).toContain('custom: [keep, all]');
  expect(note.body).toBe(body); const { authors, ...rest } = note.doc.toJS(); expect(rest).toEqual(parseNote(raw).doc.toJS());
  expect((await repo.listArticles()).map(article => article.path)).toEqual([path]);
});
it('creates typed topics without interpreting or changing unrelated historical JSON', async () => {
  const target = 'Nodes/Reserved Topic.md', legacyPath = 'Reading/Metadata/' + 'a'.repeat(64) + '.json';
  const legacy = JSON.stringify({ path: target, metadata: { id: 'legacy-topic' } });
  const store = new MemoryStore({ [path]: raw, [legacyPath]: legacy }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await repo.updateArticleTopics(path, { create: ['Reserved Topic'] });
  expect(await store.read(target)).toBe(topic);
  expect(await store.read(legacyPath)).toBe(legacy);
  expect(parseNote(await store.read(path)).body).toBe(body);
});
it('selects people and topics anywhere, reuses authored nodes, and removes assignments without touching notes', async () => {
  const store = new MemoryStore({ [path]: raw, 'People/Ada.md': person + 'Authored biography', 'Elsewhere/Computing.md': topic + 'Authored topic', 'Other.md': '---\ntype: article\n---\n' });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect(await repo.listAuthors()).toEqual([{ path: 'People/Ada.md', title: 'Ada' }]);
  expect(await repo.listTopics()).toEqual([{ path: 'Elsewhere/Computing.md', title: 'Computing' }]);
  await repo.updateArticleAuthors(path, { add: ['People/Ada.md'] }); await repo.updateArticleTopics(path, { add: ['Elsewhere/Computing.md'], create: ['Computing'] });
  expect(await store.read('Nodes/Computing.md')).toBe(topic);
  expect(parseNote(await store.read(path)).doc.toJS()).toMatchObject({ authors: ['[[People/Ada]]'], topics: ['[[Elsewhere/Computing]]', '[[Nodes/Computing]]'] });
  await repo.updateArticleAuthors(path, { remove: ['People/Ada.md'] });
  expect(parseNote(await store.read(path)).doc.has('authors')).toBe(false);
  expect(await store.read('People/Ada.md')).toBe(person + 'Authored biography'); expect(await store.read('Elsewhere/Computing.md')).toBe(topic + 'Authored topic');
});
it.each(['authors: Legacy name', 'authors: [Ada, Charles]', 'authors: {name: Ada}', 'authors: null'])('preserves unsupported legacy metadata %s and creates nothing', async metadata => {
  const initial = raw.replace('type: article', 'type: article\n' + metadata), store = new MemoryStore({ [path]: initial }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await expect(repo.updateArticleAuthors(path, { create: ['New person'] })).rejects.toThrow(); expect(store.snapshot()).toEqual({ [path]: initial });
  await repo.updateArticleTopics(path, { create: ['Computing'] });
  expect(parseNote(await store.read(path)).doc.toJS().authors).toEqual(parseNote(initial).doc.toJS().authors);
});
it('rejects unsafe names and type collisions without overwriting existing nodes', async () => {
  const store = new MemoryStore({ [path]: raw, 'Nodes/Ada.md': topic }), repo = new ReaderRepository(store, DEFAULT_SETTINGS), before = store.snapshot();
  await expect(repo.updateArticleAuthors(path, { create: ['../unsafe'] })).rejects.toThrow('unsafe');
  await expect(repo.updateArticleAuthors(path, { create: ['Ada'] })).rejects.toThrow('different'); expect(store.snapshot()).toEqual(before);
});
it('keeps created nodes on partial failure, reports them, and safely reuses them on retry', async () => {
  const store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS), create = store.create.bind(store);
  const spy = vi.spyOn(store, 'create').mockImplementation(async (target, value, options) => { if (target.endsWith('Second.md')) throw new Error('Disk full'); return create(target, value, options); });
  await expect(repo.updateArticleAuthors(path, { create: ['First', 'Second'] })).rejects.toThrow('Created nodes were kept: Nodes/First.md');
  expect(await store.read(path)).toBe(raw); expect(await store.read('Nodes/First.md')).toBe(person); spy.mockRestore();
  await repo.updateArticleAuthors(path, { create: ['First', 'Second'] }); expect((await repo.getArticle(path)).authors).toHaveLength(2);
});
it('guards the draft revision before creating staged nodes and preserves late assignments', async () => {
  const store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS), controller = new ReaderController(repo, vi.fn(), DEFAULT_SETTINGS);
  try {
    const draft = await RelationshipDraft.load(controller, path, 'authors'); draft.stage('Staged');
    await store.process(path, text => text.replace('type: article', 'type: article\nauthors: ["[[People/Concurrent]]"]'));
    await expect(draft.save()).rejects.toThrow('authors changed'); expect(await store.exists('Nodes/Staged.md')).toBe(false);
    expect((await repo.getArticle(path)).authors).toEqual(['People/Concurrent.md']);
  } finally { await controller.shutdown(); }
});
it('rejects shared relationship anchors before node creation', async () => {
  const initial = raw.replace('type: article', 'type: article\nauthors: &people ["[[People/Ada]]"]\ncustomPeople: *people');
  const store = new MemoryStore({ [path]: initial }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await expect(repo.updateArticleAuthors(path, { create: ['New'] })).rejects.toThrow('anchor'); expect(store.snapshot()).toEqual({ [path]: initial });
});
it('mutates the current native article buffer and preserves unrelated unsaved body and YAML', async () => {
  const f = nativeStore({ [path]: raw, 'People/Ada.md': person }), repo = new ReaderRepository(f.store, DEFAULT_SETTINGS);
  const unsaved = raw.replace('byline: Keep this', 'byline: Native edit').replace('User notes.', 'Unsaved native text.'), editor = f.open(path, unsaved);
  await repo.updateArticleAuthors(path, { add: ['People/Ada.md'] });
  expect(f.disk.get(path)).toContain('byline: Native edit'); expect(parseNote(f.disk.get(path)!).body).toBe(parseNote(unsaved).body);
  expect(editor.editor.reloads).toBe(0); expect(editor.editor.transactions).toHaveLength(1);
});
it('guards selected person type through the article commit boundary', async () => {
  const f = nativeStore({ [path]: raw, 'People/Ada.md': person }), repo = new ReaderRepository(f.store, DEFAULT_SETTINGS);
  let count = 0;
  f.hooks.beforeProcess = async file => { if (file.path !== path || ++count < 2) return; f.hooks.beforeProcess = undefined; await f.store.process('People/Ada.md', () => topic); };
  await expect(repo.updateArticleAuthors(path, { add: ['People/Ada.md'] })).rejects.toThrow(staleNodeFence); expect(f.disk.get(path)).toBe(raw);
});
it('reports possible saved assignments when a target changes during native save', async () => {
  const f = nativeStore({ [path]: raw, 'People/Ada.md': person }), repo = new ReaderRepository(f.store, DEFAULT_SETTINGS), editor = f.open(path);
  editor.view.gateSave = async () => { await f.store.process('People/Ada.md', () => topic); };
  await expect(repo.updateArticleAuthors(path, { add: ['People/Ada.md'] })).rejects.toThrow('Assignments may already be saved');
  expect(f.disk.get(path)).toContain('authors:'); expect(f.disk.get('People/Ada.md')).toBe(topic);
});
it('blocks stale article generation before explicit node creation', async () => {
  const store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await expect(repo.updateArticleAuthors(path, { create: ['New'] }, { expectedGeneration: 999 })).rejects.toThrow('Article changed');
  expect(store.snapshot()).toEqual({ [path]: raw });
});
