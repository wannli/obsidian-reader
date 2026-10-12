import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { ReaderRepository } from '../src/storage/repository';
import { ReaderController } from '../src/controller';
import { MemoryStore } from '../src/storage/memory';
import { parseInlineMarkdown } from '../src/inline';
import { mark, selection } from './markdown-helpers';
import { nativeStore } from './helpers/native-store';

const path = 'Reading/Stream/Article.md', inbox = 'Reading/Inbox/Article.md';
const note = (body: string, extra = '') => `---\ntype: article\npublished: 2020-01-01\ncustom: keep\n${extra}---\n${body}`;
afterEach(() => vi.restoreAllMocks());
it.each(['highlight', 'highlight link', 'node link', 'inline link', 'retarget', 'topic', 'author', 'create topic', 'create author'])('promotes Stream after %s and returns the new path/revision', async action => {
  const body = action === 'highlight link' || action === 'node link' ? '==Words==' : action === 'retarget' ? '[[Old|Words]]' : 'Words';
  const store = new MemoryStore({ [path]: note(body), 'Nodes/Topic.md': '---\ntype: topic\n---\n', 'Nodes/Person.md': '---\ntype: person\n---\n' });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS), controller = new ReaderController(repo, vi.fn(), DEFAULT_SETTINGS);
  const article = await repo.getArticle(path);
  const saved = await (action === 'highlight' ? controller.highlight(path, 'Words', (await selection(repo, path, 'Words')).anchor)
    : action === 'highlight link' ? controller.linkHighlight(path, article.highlights[0].id, 'Target')
    : action === 'node link' ? controller.linkNode(path, article.highlights[0].id, { path: 'Nodes/Topic.md', title: 'Topic', aliases: [], type: 'topic', color: 'yellow' })
    : action === 'inline link' ? repo.addLink(path, await selection(repo, path, 'Words'), 'Target')
    : action === 'retarget' ? controller.setLinkTarget(path, parseInlineMarkdown(article.body, { stripTitle: article.title }).links[0].id, 'Target')
    : action === 'topic' ? controller.assignTopics(path, { add: ['Nodes/Topic.md'] })
    : action === 'author' ? controller.assignAuthors(path, { add: ['Nodes/Person.md'] })
    : action === 'create topic' ? controller.assignTopics(path, { create: ['New topic'] })
    : controller.assignAuthors(path, { create: ['New person'] }));
  expect(saved.path).toBe(inbox); expect(saved.status).toBe('inbox');
  expect(saved.revision).toBe(await store.read(inbox)); expect(saved.revision).toContain('custom: keep');
  expect(await store.exists(path)).toBe(false); expect(repo.articleGeneration(path)).toBeGreaterThan(0);
  await controller.shutdown();
});
it.each(['Inbox', 'Later', 'Treasury'])('does not move annotations in %s', async folder => {
  const source = `Reading/${folder}/Article.md`, store = new MemoryStore({ [source]: note('Words') }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await mark(repo, source, { quote: 'Words' })).path).toBe(source);
});
it.each(['highlight', 'inline link', 'node link', 'topic', 'author', 'empty'])('does not promote on removal/no-op: %s', async action => {
  const body = action === 'inline link' ? '[[Target|Words]]' : action === 'node link' ? '==🟡[[Nodes/Topic|Words]]==' : '==Words==';
  const store = new MemoryStore({ [path]: note(body, 'topics: ["[[Nodes/Topic]]"]\nauthors: ["[[Nodes/Person]]"]\n') }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.getArticle(path);
  const saved = await (action === 'highlight' ? repo.deleteHighlight(path, article.highlights[0].id)
    : action === 'inline link' ? repo.deleteLink(path, parseInlineMarkdown(article.body, { stripTitle: article.title }).links[0].id)
    : action === 'node link' ? repo.setNodeLink(path, article.highlights[0].id, null)
    : action === 'topic' ? repo.updateArticleTopics(path, { remove: ['Nodes/Topic.md'] })
    : action === 'author' ? repo.updateArticleAuthors(path, { remove: ['Nodes/Person.md'] }) : repo.updateArticleTopics(path, {}));
  expect(saved.path).toBe(path); expect(await store.exists(inbox)).toBe(false);
});
it('rejects stale/invalid writes without promoting or changing bytes', async () => {
  const store = new MemoryStore({ [path]: note('Words') }), repo = new ReaderRepository(store, DEFAULT_SETTINGS), before = store.snapshot();
  await expect(repo.addHighlight(path, { quote: 'Words', revision: 'stale' })).rejects.toThrow();
  await expect(repo.updateArticleTopics(path, { add: ['Missing.md'] })).rejects.toThrow();
  expect(store.snapshot()).toEqual(before);
});
it.each(['collision', 'backlink', 'relative'])('preserves saved annotation when safe promotion refuses %s', async reason => {
  const raw = note('Words' + (reason === 'relative' ? ' [other](./Other.md)' : ''));
  const store = new MemoryStore({ [path]: raw, ...(reason === 'collision' ? { [inbox]: 'Existing destination' } : reason === 'backlink' ? { 'Journal.md': '[[Reading/Stream/Article]]' } : {}) });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await expect(mark(repo, path, { quote: 'Words' })).rejects.toThrow('Annotation saved, but could not move');
  expect(await store.read(path)).toContain('==Words==');
  if (reason === 'collision') expect(await store.read(inbox)).toBe('Existing destination');
  else expect(await store.exists(inbox)).toBe(false);
});
it('preserves native unsaved text and defers promotion until the Markdown editor closes', async () => {
  const f = nativeStore({ [path]: note('Words') }), repo = new ReaderRepository(f.store, DEFAULT_SETTINGS);
  const native = f.open(path, note('Words\n\nUnsaved notes'));
  await expect(repo.addHighlight(path, { quote: 'Words', revision: parseInlineMarkdown('Words\n\nUnsaved notes', { stripTitle: 'Article' }).revision })).rejects.toThrow('Close the article');
  expect(f.disk.get(path)).toContain('==Words==\n\nUnsaved notes'); expect(native.editor.reloads).toBe(0);
  expect(native.editor.transactions).toHaveLength(1); expect(f.vault.rename).not.toHaveBeenCalled();
  f.leaves.length = 0;
  expect((await repo.setStatus(path, 'inbox')).path).toBe(inbox);
  expect(f.disk.get(inbox)).toContain('==Words==\n\nUnsaved notes');
});
it.each(['==Words==', '==🟡[[Nodes/Topic|Words]]==', 'Words'])('cleanup promotes existing expired annotations, not unknown full text: %s', async body => {
  const extra = body === 'Words' ? 'topics: ["[[Nodes/Topic]]"]\n' : '';
  const raw = note(body, extra), unknown = 'Reading/Stream/Unknown.md';
  const store = new MemoryStore({ [path]: raw, [unknown]: note('Unknown publisher text with [link](https://example.com)') }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const result = await repo.cleanupStream(Date.now());
  expect(await store.read(inbox)).toBe(raw); expect(result.deleted).toEqual([]); expect(result.retained).toEqual([unknown]);
});
it('cleanup retains busy or move-blocked annotations', async () => {
  const raw = note('==Words=='), store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.cleanupStream(Date.now(), () => true)).retained).toEqual([path]);
  await store.create(inbox, 'Destination');
  expect((await repo.cleanupStream(Date.now())).retained).toEqual([path]); expect(await store.read(path)).toBe(raw);
});
