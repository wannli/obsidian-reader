import { describe, expect, it } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
import { sidecarPath } from './sidecar-helpers';
import { readingPosition } from '../src/reading-position';
import { parseNote, writeNote } from '../src/storage/markdown';
import { parseInlineMarkdown } from '../src/inline';

const position = { marker: 'original sentence.' };
describe('persistent reading position', () => {
  it('serializes frontmatter mutations, preserves body/custom fields, and survives restart and queue/native moves', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
    let article = await repo.createArticle({ title: 'Reading', url: 'https://example.com/read', body: 'The original sentence.' });
    await store.process(article.path, raw => raw.replace('type: article', 'type: article\ncustom: keep\ntopics: ["[[Science]]"]'));
    const raw = await store.read(article.path);
    await Promise.all([
      repo.saveReadingPosition(article.path, position, article.id),
      repo.setArticleError(article.path, 'Keep this error'),
    ]);
    const saved = parseNote(await store.read(article.path)), original = parseNote(raw);
    expect(saved.body).toBe(original.body);
    expect(saved.doc.toJS()).toEqual({ ...original.doc.toJS(), reading_position: position.marker, error: 'Keep this error' });
    expect(await store.exists(sidecarPath(article.path))).toBe(false);
    expect(Object.keys(store.snapshot())).toEqual([article.path]);
    const beforePrepare = await store.read(article.path);
    expect((await repo.prepareStorage()).errors).toEqual([]);
    expect(await store.read(article.path)).toBe(beforePrepare);
    const restarted = new ReaderRepository(new MemoryStore(store.snapshot()), { ...DEFAULT_SETTINGS });
    expect(await restarted.getArticle(article.path)).toMatchObject({ readingPosition: position, error: 'Keep this error' });
    article = await repo.addHighlight(article.path, { quote: 'original', revision: parseInlineMarkdown(article.body, { stripTitle: article.title }).revision });
    article = await repo.setStatus(article.path, 'later');
    expect(article.readingPosition).toEqual(position);
    expect(article.highlights).toHaveLength(1);
    const renamed = 'Reading/Later/Renamed.md';
    await store.rename(article.path, renamed, { expectedContent: await store.read(article.path) });
    await repo.articleRenamed(article.path, renamed);
    expect((await repo.getArticle(renamed)).readingPosition).toEqual(position);
    expect(parseNote(await store.read(renamed)).doc.toJS().reading_position).toEqual(position.marker);
    expect(await store.exists(sidecarPath(renamed))).toBe(false);
    expect(Object.keys(store.snapshot())).toEqual([renamed]);
    await expect(repo.saveReadingPosition(article.path, position, article.id)).rejects.toThrow();
  });
  it('retains positions in Markdown alone without stamping identity on native notes', async () => {
    const path = 'Reading/Inbox/Native.md';
    const store = new MemoryStore({ [path]: '---\ntype: article\ncustom: keep\n---\nOriginal body.\n' });
    const repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
    const before = parseNote(await store.read(path));
    const id = await repo.saveReadingPosition(path, position, '');
    expect(id).toBe('');
    const saved = parseNote(await store.read(path));
    expect(saved.body).toBe(before.body);
    expect(saved.doc.toJS()).toEqual({ ...before.doc.toJS(), reading_position: position.marker });
    expect(Object.keys(store.snapshot())).toEqual([path]);
    await repo.saveReadingPosition(path, { marker: 'sentence.' }, id);
    const markdownOnly = new ReaderRepository(new MemoryStore({ [path]: await store.read(path) }), { ...DEFAULT_SETTINGS });
    expect((await markdownOnly.getArticle(path)).readingPosition?.marker).toBe('sentence.');
    expect((await markdownOnly.prepareStorage()).errors).toEqual([]);
    expect((await markdownOnly.getArticle(path)).readingPosition?.marker).toBe('sentence.');
  });
  it('rejects an idless same-path replacement before generation notification, including no-op positions', async () => {
    const path = 'Reading/Inbox/Reused.md';
    const store = new MemoryStore({ [path]: '---\ntype: article\nreading_position: "old"\n---\nOld text.' });
    const repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
    const observed = (await repo.getArticle(path)).revision!;
    const generation = repo.articleGeneration(path);
    await store.process(path, () => '---\ntype: article\nreading_position: "old"\n---\nReplacement text.');
    const replacement = await store.read(path);
    expect(repo.articleGeneration(path)).toBe(generation);
    for (const marker of ['old', 'Replacement']) {
      await expect(repo.saveReadingPositionRevision(path, { marker }, '', generation, observed)).rejects.toThrow();
      expect(await store.read(path)).toBe(replacement);
    }
  });
  it('returns committed raw bytes for sequential position writes after confirmed annotation edits', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
    let article = await repo.createArticle({ title: 'Reading', url: '', body: 'Some original words.' });
    const generation = repo.articleGeneration(article.path);
    const first = await repo.saveReadingPositionRevision(article.path, { marker: 'Some original' }, article.id, generation, article.revision!);
    expect(first.revision).toBe(await store.read(article.path));
    article = await repo.addHighlight(article.path, { quote: 'original', revision: parseInlineMarkdown(article.body, { stripTitle: article.title }).revision });
    const second = await repo.saveReadingPositionRevision(article.path, { marker: 'original words' }, article.id, generation, article.revision!);
    expect(second.revision).toBe(await store.read(article.path));
    expect((await repo.getArticle(article.path)).readingPosition?.marker).toBe('original words');
    await expect(repo.saveReadingPositionRevision(article.path, { marker: 'stale' }, article.id, generation, first.revision)).rejects.toThrow();
  });
  it('ignores malformed synced positions and rejects invalid writes without modifying files', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
    const article = await repo.createArticle({ title: 'Reading', url: '', body: 'Text' });
    for (const invalid of [null, [], {}, { marker: 'one two' }, { marker: 42 }, { marker: 'x'.repeat(257) }, { marker: 'one two three four five six' }, 'one two three four five six']) {
      expect(readingPosition(invalid)).toBeUndefined();
    }
    expect(readingPosition('one two three four five')).toEqual({ marker: 'one two three four five' });
    const before = store.snapshot();
    await expect(repo.saveReadingPosition(article.path, { marker: 'one two three four five six' }, article.id)).rejects.toThrow('Invalid reading position');
    expect(store.snapshot()).toEqual(before);
    await store.process(article.path, raw => {
      const note = parseNote(raw); note.doc.set('reading_position', note.doc.createNode({ marker: 42 })); return writeNote(note);
    });
    expect((await repo.getArticle(article.path)).readingPosition).toBeUndefined();
    await expect(repo.saveReadingPosition(article.path, position, 'wrong-id')).rejects.toThrow();
  });
});
