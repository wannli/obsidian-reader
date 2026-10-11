import { readNoteRaw, rawStore } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ExtractedArticle } from '../src/types';
import { dummyArticle } from '../src/ingest/dummy';
import { parseNote, writeNote } from '../src/storage/markdown';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';

const path = 'Capture.md';
const dummy = dummyArticle('https://example.com/article');
const live: ExtractedArticle = {
  title: 'Publisher', markdown: '# Real article\n\nFetched publisher text.', status: 'ready', extractor: 'defuddle',
};

async function fixture() {
  const store = new MemoryStore({ [path]: '---\ntype: article\nid: capture\nurl: https://example.com/article\n' +
    '# Preserve my metadata\ncustom: [keep, this]\n---\n' +
    '## Article\n\n## Comments\n\nPersonal comments.\n\n## Highlights\n' });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await repo.saveContent(path, dummy);
  await rawStore(store).process(path, raw => {
    const note = parseNote(raw);
    note.doc.set('content', 'ready');
    note.doc.set('error', 'Keep this error');
    note.doc.set('retryAfter', '2030-01-01T00:00:00Z');
    return writeNote(note);
  });
  const raw = await readNoteRaw(store, path);
  expect(parseNote(raw).doc.has('sourceHash')).toBe(false);
  expect(await repo.getArticle(path)).toMatchObject({ extractor: 'dummy', content: 'ready', highlights: [] });
  return { store, repo, raw };
}

async function protect(store: MemoryStore, before: string) {
  // Simulate another writer changing only content state, not body/hash or any other metadata.
  await rawStore(store).process(path, raw => {
    const note = parseNote(raw);
    note.doc.set('content', 'protected');
    return writeNote(note);
  });
  const protectedRaw = await readNoteRaw(store, path);
  expect(protectedRaw).not.toBe(before);
  expect(parseNote(protectedRaw).body).toBe(parseNote(before).body);
  expect(parseNote(protectedRaw).doc.toJS()).toEqual({ ...parseNote(before).doc.toJS(), content: 'protected' });
  return protectedRaw;
}

function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}

describe('late content protection at the storage write boundary', () => {
  it.each(['ready', 'partial'] as const)('vetoes a gated real %s result after only content becomes protected', async status => {
    const { store, repo, raw } = await fixture();
    const resultGate = gate<ExtractedArticle>(), started = gate<void>();
    const fetchAndSave = async () => {
      started.release();
      const result = await resultGate.promise;
      return repo.saveContent(path, result);
    };
    const inFlight = fetchAndSave();
    await started.promise;
    const protectedRaw = await protect(store, raw);
    const protectedArticle = await repo.getArticle(path), snapshot = store.snapshot();
    resultGate.release({ ...live, status, ...(status === 'partial' ? { warning: 'Late partial warning' } : {}) });
    const saved = await inFlight;
    expect(await readNoteRaw(store, path)).toBe(protectedRaw);
    expect(store.snapshot()).toEqual(snapshot);
    expect(saved).toEqual(protectedArticle);
    expect(saved).toMatchObject({ extractor: 'dummy', content: 'protected', body: dummy.markdown,
      error: 'Keep this error', retryAfter: '2030-01-01T00:00:00Z', highlights: [] });
  });

  it('returns the unchanged protected article for direct saveContent', async () => {
    const { store, repo, raw } = await fixture();
    const protectedRaw = await protect(store, raw);
    const protectedArticle = await repo.getArticle(path), snapshot = store.snapshot();
    expect(await repo.saveContent(path, live)).toEqual(protectedArticle);
    expect(await readNoteRaw(store, path)).toBe(protectedRaw);
    expect(store.snapshot()).toEqual(snapshot);
    expect(await repo.getArticle(path)).toMatchObject({ extractor: 'dummy', content: 'protected' });
  });
});
