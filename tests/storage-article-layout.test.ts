import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { parseNote } from '../src/storage/markdown';
import { parseInlineMarkdown } from '../src/inline';
import { mark } from './markdown-helpers';

const live = { title: 'Publisher', markdown: 'Fresh source.', status: 'ready' as const, extractor: 'defuddle' as const };
it.each(['Source', 'Source\n', '\nSource\n\n', 'Source\r\n'])('inline marks never introduce generated Article/Highlights wrappers: %j', async body => {
  const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Title', url: '', body });
  const marked = await mark(repo, article.path, { quote: 'Source' });
  expect(parseNote(await store.read(article.path)).body).toBe(body.replace('Source', '==Source=='));
  await repo.deleteHighlight(article.path, marked.highlights[0].id);
  expect(parseNote(await store.read(article.path)).body).toBe(body);
});
it.each(['## Article\n', '## Highlights\n\n## Article\n', 'Personal preamble.\n\n## Highlights\n\n## Article\n'])('fills existing capture layout without generating new sections: %j', async body => {
  const path = 'Capture.md', store = new MemoryStore({ [path]: '---\ntype: article\nurl: https://example.com\n---\n' + body });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.saveContent(path, live)).body).toBe(live.markdown);
  const before = parseNote(await store.read(path)).body;
  const marked = await mark(repo, path, { quote: 'Fresh' });
  expect(parseNote(await store.read(path)).body).toBe(before.replace('Fresh', '==Fresh=='));
  await repo.deleteHighlight(path, marked.highlights[0].id);
  expect(parseNote(await store.read(path)).body).toBe(before);
});
it('keeps publisher reserved headings and authored Comments through mark/link/unlink', async () => {
  const path = 'Capture.md', raw = '---\ntype: article\nurl: https://example.com\n---\n## Article\n\n## Comments\n\nMy comments.\n';
  const store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const markdown = '# Publisher\n\n## Highlights\nPublisher highlights.\n\n## Article\nPublisher article.\n\n## Comments\nPublisher comments.\n';
  await repo.saveContent(path, { ...live, markdown });
  const before = parseNote(await store.read(path)).body;
  const marked = await mark(repo, path, { quote: 'Publisher article.' });
  const linked = await repo.setHighlightLink(path, marked.highlights[0].id, 'Target');
  await repo.deleteLink(path, parseInlineMarkdown(linked.body, { stripTitle: linked.title }).links[0].id);
  expect(parseNote(await store.read(path)).body).toBe(before);
  expect(await store.read(path)).toContain('My comments.');
});
it('startup retains untracked authored legacy quote blocks for explicit review', async () => {
  const path = 'Legacy.md', raw = '---\ntype: article\ncustom: keep\n---\n## Article\n\nSource.\n\n## Highlights\n\n> Edited excerpt\n\n^hl-old\n\n## Comments\n\nMy writing.';
  const store = new MemoryStore({ [path]: raw, 'Daily/old.md': '[[Legacy#^hl-old]]' }), repo = new ReaderRepository(store, DEFAULT_SETTINGS), before = store.snapshot();
  expect((await repo.prepareStorage()).errors.length).toBeGreaterThan(0);
  expect(store.snapshot()).toEqual(before);
});
it('annotation edits never bless newly authored source as replaceable', async () => {
  const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Summary', url: '', body: 'Summary text.', extractor: 'summary' });
  await store.process(article.path, raw => raw.replace('Summary text.', 'Summary text. Authored addition.'));
  const marked = await mark(repo, article.path, { quote: 'Summary' });
  await repo.deleteHighlight(article.path, marked.highlights[0].id);
  const before = parseNote(await store.read(article.path)).body;
  expect((await repo.saveContent(article.path, live)).content).toBe('protected');
  expect(parseNote(await store.read(article.path)).body).toBe(before);
});
