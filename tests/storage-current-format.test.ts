import { expect, it } from 'vitest';
import { mark } from './markdown-helpers';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';
import { parseNote } from '../src/storage/markdown';
import { fingerprint } from '../src/storage/fingerprint';
import { displayedSource, sourceRegion } from '../src/storage/source';

it('preserves unknown metadata and JSON without granting ownership or blocking ordinary writes', async () => {
  const path = 'Reading/Inbox/Old.md', jsonPath = 'Reading/Metadata/old.json';
  const body = 'Unknown publisher text.';
  const raw = `---\ntype: article\nid: [unknown, shape]\nguid: old\npullmanFormat: future\npullmanLegacyHash: receipt\nqueueMove: {to: Other.md}\nhighlights: [{id: old}]\nextractor: defuddle\nsourceHash: ${fingerprint(body)}\nsourceLength: ${body.length}\n---\n${body}`;
  const json = '{unrecognized JSON';
  const store = new MemoryStore({ [path]: raw, [jsonPath]: json }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.getArticle(path)).extractor).toBe('manual');
  await repo.setArticleError(path, 'Retry later');
  const saved = parseNote(await store.read(path));
  expect(saved.body).toBe(body);
  const { error, ...properties } = saved.doc.toJS();
  expect(error).toBe('Retry later');
  expect(properties).toEqual(parseNote(raw).doc.toJS());
  expect(await store.read(jsonPath)).toBe(json);
  await repo.saveContent(path, { title: 'Replacement', markdown: 'Do not replace', status: 'ready', extractor: 'defuddle' });
  expect(parseNote(await store.read(path)).body).toBe(body);
});

it('uses current layout stamps for non-leading Article sections without trusting extraction stamps', () => {
  const source = '\nPublisher text.\n\n## Publisher subsection\nMore text.\n\n';
  const note = parseNote(`---\ntype: article\nsourceLayoutLength: ${source.length}\nsourceLayoutHash: ${fingerprint(source)}\n---\nAuthored preamble.\n\n## Article\n${source}## Private tail\nKeep this.`);
  const region = sourceRegion(note);
  expect(displayedSource(region)).toBe(source.slice(1, -2));
  expect(note.body.slice(region.end)).toBe('## Private tail\nKeep this.');
});

it('honors current flat layout stamps without hiding publisher reserved headings', () => {
  const body = '## Article\nPublisher text.\n\n## Comments\nPublisher conclusion.';
  const note = parseNote(`---\ntype: article\nsourceLayoutLength: ${body.length}\nsourceLayoutHash: ${fingerprint(body)}\n---\n${body}`);
  expect(displayedSource(sourceRegion(note))).toBe(body);
});

it('updates section layout atomically on summary replacement and retains arbitrary authored tails', async () => {
  const path = 'Reading/Inbox/Excerpt.md', source = '\nExcerpt.\n\n', tail = '## My notes\nPrivate writing.';
  const raw = `---\ntype: article\nurl: https://example.com/read\nsummary: Excerpt.\narticleSection: Article\nsourceLayoutLength: ${source.length}\nsourceLayoutHash: ${fingerprint(source)}\n---\n## Article\n${source}${tail}`;
  const store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const saved = await repo.saveContent(path, { title: 'Publisher', markdown: 'Fresh publisher text.', status: 'ready', extractor: 'defuddle' });
  expect(saved.body).toBe('Fresh publisher text.');
  const marked = await mark(repo, path, { quote: 'publisher' });
  expect(marked.body).toBe('Fresh ==publisher== text.');
  expect(parseNote(await store.read(path)).body.endsWith(tail)).toBe(true);
  await store.process(path, current => current.replace('Fresh', 'Native edit'));
  const before = await store.read(path);
  await expect(repo.addHighlight(path, { quote: 'Private' })).rejects.toThrow(/layout/i);
  expect(await store.read(path)).toBe(before);
});
