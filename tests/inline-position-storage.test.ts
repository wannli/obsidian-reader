import { expect, it } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { StorageContext } from '../src/storage/context';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
import { parseNote, writeNote, newNote } from '../src/storage/markdown';
import { parseInlineMarkdown } from '../src/inline';
import { fingerprint } from '../src/storage/fingerprint';
import { queued } from '../src/storage/safety';
import { sidecarPath } from './sidecar-helpers';

const path = 'Reading/Inbox/Position.md', nextPath = 'Reading/Later/Position.md';
const position = { marker: 'source words.' };
const body = 'Some source words.\r\n\r\n## Comments\r\nKeep this exact.\r\n';
const note = (properties = {}, text = body) => writeNote(newNote({ type: 'article', title: 'Position', id: 'article-position', pullmanFormat: 'inline-v1', content: 'protected', extractor: 'manual', sourceHash: fingerprint(text), sourceLength: text.length, custom: { nested: ['keep', 7] }, ...properties }, text));
const reader = (store: MemoryStore) => new ReaderRepository(store, DEFAULT_SETTINGS);
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

it('only position YAML changes while body, marks, links, source stamps and protected state stay exact', async () => {
  const raw = note({}, body.replace('source', '==source==').replace('words', '[[Topic|words]]'));
  const store = new MemoryStore({ [path]: raw }), repo = reader(store), before = parseNote(raw);
  expect(await repo.saveReadingPosition(path, position)).toBeUndefined();
  const after = parseNote(await store.read(path));
  expect(after.body).toBe(before.body);
  expect(after.doc.toJS()).toEqual({ ...before.doc.toJS(), reading_position: position.marker });
  expect(await store.read(path)).toContain('reading_position: "source words."');
  expect(Object.keys(store.snapshot())).toEqual([path]);
  const snapshot = store.snapshot();
  await repo.saveReadingPosition(path, { ...position });
  expect(store.snapshot()).toEqual(snapshot);
});

it('identical native positions are true no-ops without allocating identity or format', async () => {
  const raw = writeNote(newNote({ type: 'article', custom: 'keep', reading_position: position.marker }, body));
  const store = new MemoryStore({ [path]: raw });
  expect(await reader(store).saveReadingPosition(path, position)).toBeUndefined();
  expect(await store.read(path)).toBe(raw);
});

it('ignores legacy map positions and refuses to overwrite their preserved YAML', async () => {
  const original = '\uFEFF---\r\ntype: article\r\ncustom: keep\r\nreading_position:\r\n  marker: Words\r\n  offset: 0.375\r\n---\r\nWords\r\n';
  const store = new MemoryStore({ [path]: original }), repo = reader(store);
  expect((await repo.getArticle(path)).readingPosition).toBeUndefined();
  await expect(repo.saveReadingPosition(path, { marker: 'Words' })).rejects.toThrow(/Unsupported reading_position/);
  expect(await store.read(path)).toBe(original);
});

it.each([
  { marker: 'Words', future: 'keep' },
  { marker: 2 },
  {},
])('refuses to overwrite unsupported reading_position YAML %j', async existing => {
  const original = writeNote(newNote({ type: 'article', custom: 'keep', reading_position: existing }, body));
  const store = new MemoryStore({ [path]: original }), repo = reader(store);
  expect((await repo.getArticle(path)).readingPosition).toBeUndefined();
  await expect(repo.saveReadingPosition(path, { marker: 'Words' })).rejects.toThrow(/Unsupported reading_position/);
  expect(await store.read(path)).toBe(original);
});

it('identical positions still require matching revision and generation', async () => {
  const raw = note({ reading_position: position.marker }), store = new MemoryStore({ [path]: raw }), repo = reader(store);
  await expect(repo.saveReadingPositionRevision(path, position, repo.articleGeneration(path), raw + 'stale')).rejects.toThrow();
  await expect(repo.saveReadingPosition(path, position, repo.articleGeneration(path) + 1)).rejects.toThrow();
  expect(await store.read(path)).toBe(raw);
});

it('takes the body and state from the latest process buffer without restamping a native edit', async () => {
  class EditingStore extends MemoryStore {
    override async process(file: string, update: (current: string) => string) {
      return super.process(file, current => update(current.replace('Some source words.', 'Native editor source.')));
    }
  }
  const raw = note({ content: 'partial', extractor: 'summary' }), store = new EditingStore({ [path]: raw });
  await reader(store).saveReadingPosition(path, position);
  const before = parseNote(raw), saved = parseNote(await store.read(path));
  expect(saved.body).toBe(before.body.replace('Some source words.', 'Native editor source.'));
  expect(saved.doc.toJS()).toEqual({ ...before.doc.toJS(), reading_position: position.marker });
});

it('checks the exact current process buffer, not a prior read, before writing an idless position', async () => {
  class ReplacingStore extends MemoryStore {
    override async process(file: string, update: (current: string) => string) {
      return super.process(file, current => update(current.replace('Old article.', 'Replacement article.')));
    }
  }
  const raw = writeNote(newNote({ type: 'article' }, 'Old article.'));
  const store = new ReplacingStore({ [path]: raw }), repo = reader(store);
  await expect(repo.saveReadingPositionRevision(path, position, repo.articleGeneration(path), raw)).rejects.toThrow();
  expect(await store.read(path)).toBe(raw);
});

it('snapshots mutable caller position input before queueing', async () => {
  const store = new MemoryStore({ [path]: note() }), repo = reader(store), held = gate(), input = { ...position };
  const barrier = queued(store, () => held.promise);
  const writing = repo.saveReadingPosition(path, input);
  input.marker = 'Changed while queued'; held.release(); await barrier; await writing;
  expect((await repo.getArticle(path)).readingPosition).toEqual(position);
});

it('position permission is narrow: annotation/general writes cannot silently change position aliases', async () => {
  const raw = '---\ntype: article\ncontent: &state ready\nreading_position:\n  marker: empty\n  custom: *state\n---\nSome source words.';
  const store = new MemoryStore({ [path]: raw }), repo = reader(store);
  await repo.addHighlight(path, { quote: 'source', revision: parseInlineMarkdown('Some source words.', { stripTitle: 'Position' }).revision });
  const afterAnnotation = await store.read(path);
  expect(parseNote(afterAnnotation).doc.toJS().reading_position).toEqual({ marker: 'empty', custom: 'ready' });
  const context = new StorageContext(store, DEFAULT_SETTINGS);
  await expect(context.mutate(path, 'article', next => { next.doc.set('reading_position', next.doc.createNode(position)); })).rejects.toThrow(/custom properties/);
  expect(await store.read(path)).toBe(afterAnnotation);
});

it.each(['custom', 'sourceLength'])('position writes preserve shared aliases in %s rather than strand them', async key => {
  const raw = '---\ntype: article\nid: article-position\nreading_position: &position\n  marker: empty\n' + key + ': *position\n---\n' + body;
  const store = new MemoryStore({ [path]: raw });
  await expect(reader(store).saveReadingPosition(path, position)).rejects.toThrow();
  expect(await store.read(path)).toBe(raw);
});

it.each(['rename', 'delete', 'same-byte-recreate', 'suspend'] as const)('rejects a queued position write after %s', async action => {
  const raw = note(), store = new MemoryStore({ [path]: raw }), repo = reader(store), held = gate();
  const barrier = queued(store, () => held.promise);
  const writing = repo.saveReadingPosition(path, position).then(() => undefined, error => error);
  if (action === 'rename' || action === 'delete') {
    await store.rename(path, nextPath, { expectedContent: raw });
    if (action === 'rename') await repo.articleRenamed(path, nextPath); else await repo.articleDeleted(path);
  } else if (action === 'same-byte-recreate') {
    await repo.articleDeleted(path); await store.process(path, () => raw);
  } else repo.suspendStorage('Storage suspended');
  const before = store.snapshot(); held.release(); await barrier;
  expect(await writing).toBeInstanceOf(Error);
  expect(store.snapshot()).toEqual(before);
});

it.each(['generation', 'suspension'] as const)('rechecks %s at the actual process callback, not just before dispatch', async change => {
  const entered = gate(), held = gate();
  class DelayedStore extends MemoryStore {
    override async process(file: string, update: (current: string) => string) {
      entered.release(); await held.promise; return super.process(file, update);
    }
    nativeEdit() { return super.process(path, current => current.replace('article-position', 'article-replacement')); }
  }
  const store = new DelayedStore({ [path]: note() }), repo = reader(store);
  const writing = repo.saveReadingPosition(path, position).then(() => undefined, error => error);
  await entered.promise;
  if (change === 'generation') await repo.articleDeleted(path);
  else repo.suspendStorage('Storage suspended');
  const before = store.snapshot(); held.release();
  expect(await writing).toBeInstanceOf(Error); expect(store.snapshot()).toEqual(before);
});

it('a queued queue move does not redirect a stale position save onto its destination', async () => {
  const store = new MemoryStore({ [path]: note() }), repo = reader(store);
  const moving = repo.setStatus(path, 'later');
  const writing = repo.saveReadingPosition(path, position).catch(error => error);
  const moved = await moving;
  expect(await writing).toBeInstanceOf(Error);
  expect(moved.path).toBe(nextPath);
  expect(await store.read(nextPath)).toBe(note());
});

it.each(['template'])('position writes respect %s protection', async protection => {
  const properties = {};
  const files: Record<string, string> = { [path]: note(properties) };
  const store = new MemoryStore(files), repo = new ReaderRepository(store, DEFAULT_SETTINGS, protection === 'template' ? { files: [path] } : {});
  await expect(repo.saveReadingPosition(path, position)).rejects.toThrow();
  expect(store.snapshot()).toEqual(files);
});

it('keeps current inline-note position through mark/link/unlink/unmark', async () => {
  const raw = writeNote(newNote({ type: 'article', title: 'Position', id: 'article-position', pullmanFormat: 'inline-v1', extractor: 'manual', content: 'ready', reading_position: position.marker, custom: 'keep' }, 'Some source words.'));
  const store = new MemoryStore({ [path]: raw }), repo = reader(store);
  let article = await repo.getArticle(path);
  const selection = () => ({ quote: 'source', revision: parseInlineMarkdown(article.body, { stripTitle: article.title }).revision });
  article = await repo.addHighlight(path, selection());
  article = await repo.setHighlightLink(path, article.highlights[0].id, 'Topic');
  article = await repo.deleteLink(path, parseInlineMarkdown(article.body, { stripTitle: article.title }).links[0].id);
  article = await repo.addHighlight(path, selection());
  article = await repo.deleteHighlight(path, article.highlights[0].id);
  expect(article.body).toBe('Some source words.'); expect(article.readingPosition).toEqual(position);
  expect(parseNote(await store.read(path)).doc.toJS().reading_position).toEqual(position.marker);
  expect(Object.keys(store.snapshot())).toEqual([path]);
});
