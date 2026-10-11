import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { parseNote } from '../src/storage/markdown';
import { mark, selection } from './markdown-helpers';

const path = 'Reading/Inbox/Source.md';
const yaml = '---\ntype: article\ncustom: keep\n---\n';
describe('inline highlight persistence', () => {
  it.each(['Source', 'Source\n', '\nSource\n\n', 'Source\r\n', '**Source** and tail'])('round-trips source bytes without wrappers: %j', async body => {
    const store = new MemoryStore({ [path]: yaml + body }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const saved = await mark(repo, path, { quote: 'Source' });
    expect(saved.highlights).toHaveLength(1);
    expect(parseNote(await store.read(path)).body).toContain('==');
    await repo.deleteHighlight(path, saved.highlights[0].id);
    expect(parseNote(await store.read(path)).body).toBe(body);
    expect(Object.keys(store.snapshot())).toEqual([path]);
    expect(parseNote(await store.read(path)).doc.get('custom')).toBe('keep');
    expect(parseNote(await store.read(path)).doc.has('highlights')).toBe(false);
  });
  it('derives annotations from current Markdown after restart without persisted offsets or IDs', async () => {
    const store = new MemoryStore({ [path]: yaml + 'Source text.' }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await mark(repo, path, { quote: 'Source' });
    const raw = await store.read(path), restarted = new ReaderRepository(new MemoryStore(store.snapshot()), DEFAULT_SETTINGS);
    expect((await restarted.getArticle(path)).highlights[0].quote).toBe('Source');
    const properties = parseNote(raw).doc.toJS();
    for (const key of ['highlights', 'start', 'end', 'prefix', 'suffix']) expect(properties).not.toHaveProperty(key);
    expect(raw).not.toMatch(/## Highlights|## Article|\^hl-|<!--/);
  });
  it('targets repeated text by current source position and rejects stale IDs', async () => {
    const store = new MemoryStore({ [path]: yaml + 'Repeat here. Repeat there.' }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await expect(mark(repo, path, { quote: 'Repeat' })).rejects.toThrow(/repeated|missing/i);
    const saved = await mark(repo, path, await selection(repo, path, 'Repeat', 1));
    expect(parseNote(await store.read(path)).body).toBe('Repeat here. ==Repeat== there.');
    await store.process(path, raw => raw + '\nUser writing.');
    const before = store.snapshot();
    await expect(repo.deleteHighlight(path, saved.highlights[0].id)).rejects.toThrow(/changed/i);
    expect(store.snapshot()).toEqual(before);
  });
  it('protects source after mark and unmark without granting new extraction ownership', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const article = await repo.createArticle({ title: 'Dummy', url: '', body: 'Dummy source.', extractor: 'dummy' });
    const before = parseNote(await store.read(article.path)).doc.get('sourceHash');
    const saved = await mark(repo, article.path, { quote: 'Dummy' });
    await repo.deleteHighlight(article.path, saved.highlights[0].id);
    const result = await repo.saveContent(article.path, { title: 'Live', markdown: 'Replacement.', extractor: 'defuddle', status: 'ready' });
    expect(result.content).toBe('protected'); expect(result.body).toBe('Dummy source.');
    expect(parseNote(await store.read(article.path)).doc.get('sourceHash')).toBe(before);
  });
  it.each(['Absent', ''])('rejects missing or blank selection without any write: %j', async quote => {
    const store = new MemoryStore({ [path]: yaml + 'Actual source.' }), repo = new ReaderRepository(store, DEFAULT_SETTINGS), before = store.snapshot();
    await expect(mark(repo, path, { quote })).rejects.toThrow(); expect(store.snapshot()).toEqual(before);
  });
});
