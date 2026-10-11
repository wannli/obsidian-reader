import { readNoteRaw } from './markdown-helpers';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ExtractedArticle } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { StorageContext } from '../src/storage/context';
import { parseNote } from '../src/storage/markdown';
import { StaleArticleWriteError } from '../src/storage/preconditions';

const path = 'Capture.md', requestedUrl = 'https://example.com/original';
const deadline = '2031-01-01T00:00:00Z';
const live: ExtractedArticle = { title: 'Original publisher', markdown: 'Response from the ORIGINAL URL.', status: 'ready', extractor: 'defuddle' };
const initial = '\uFEFF---\r\ntype: article\r\nurl: ' + requestedUrl + '\r\nstatus: later\r\n' +
  '# Keep these authored properties and formatting\r\ncustom: &keep [one, two]\r\nreference: *keep\r\n' +
  'error: Preserve the previous message\r\nretryAfter: "2030-01-01T00:00:00Z"\r\n---\r\n' +
  '## Article\r\n\r\n## Comments\r\n\r\nLiteral {{VALUE:example}} and personal writing.\r\n';
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
class DelayedStore extends MemoryStore {
  readonly entered = gate(); readonly resume = gate();
  committedChanges = 0;
  override async process(path: string, update: (raw: string) => string): Promise<void> {
    this.entered.release(); await this.resume.promise;
    return super.process(path, raw => {
      const next = update(raw);
      if (next !== raw) this.committedChanges++;
      return next;
    });
  }
  externalEdit(raw: string): Promise<void> { return super.process(path, () => raw); }
}

for (const outcome of ['success', 'failure'] as const) describe('atomic original-URL precondition: ' + outcome, () => {
  it.each([
    'not-an-http-url', '{{VALUE:url}}', 'https://example.com/%7B%7BVALUE:url%7D%7D',
    'https://example.com/different', requestedUrl + '#changed', '',
  ])('rejects latest URL %s at process time, without ID-only or other writes', async latestUrl => {
    const store = new DelayedStore({ [path]: initial }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect(parseNote(initial).doc.has('id')).toBe(false);
    const originalRequestUrl = (await repo.getArticle(path)).url;
    // Fake HTTP models the original request only; never retarget it after the edit.
    const http = vi.fn(async (_url: string) => { if (outcome === 'failure') throw new Error('Original request failed'); return live; });
    const acquisition = (async () => {
      const fetched = await http(originalRequestUrl).then(result => ({ result }), error => ({ error }));
      if ('result' in fetched)
        return repo.saveContent(path, fetched.result, { expectedUrl: originalRequestUrl, allowFeedReplacement: true });
      return repo.setArticleError(path, fetched.error.message, deadline, { expectedUrl: originalRequestUrl });
    })().then(value => ({ value }), error => ({ error }));
    await store.entered.promise;
    const latest = initial.replace('url: ' + requestedUrl, 'url: ' + JSON.stringify(latestUrl));
    await store.externalEdit(latest);
    store.resume.release();
    const settled = await acquisition;
    expect(settled).toHaveProperty('error');
    if ('error' in settled) {
      expect(settled.error).toBeInstanceOf(StaleArticleWriteError);
      expect(settled.error).toMatchObject({ name: 'StaleArticleWriteError', code: 'STALE_ARTICLE_WRITE' });
    }
    expect(await store.read(path)).toBe(latest);
    expect(store.snapshot()).toEqual({ [path]: latest });
    expect(store.committedChanges).toBe(0);
    expect(parseNote(await readNoteRaw(store, path)).doc.has('id')).toBe(false);
    expect(http).toHaveBeenCalledExactlyOnceWith(requestedUrl);
  });

  it('permits the unchanged original URL and persists intended state only', async () => {
    const store = new MemoryStore({ [path]: initial }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    if (outcome === 'success') await repo.saveContent(path, live, { expectedUrl: requestedUrl });
    else await repo.setArticleError(path, 'Original request failed', deadline, { expectedUrl: requestedUrl });
    const note = parseNote(await readNoteRaw(store, path));
    expect(note.doc.has('content')).toBe(false);
    expect(note.doc.has('id')).toBe(false);
    if (outcome === 'success') expect(note.body).toContain(live.markdown);
    expect(note.doc.get('url')).toBe(requestedUrl);
    expect(note.doc.toJS().custom).toEqual(['one', 'two']);
    expect(note.doc.toJS().reference).toEqual(['one', 'two']);
    expect(note.body).toContain('Literal {{VALUE:example}} and personal writing.\r\n');
    expect(note.doc.has('expectedUrl')).toBe(false); expect(note.doc.has('allowFeedReplacement')).toBe(false);
    if (outcome === 'failure') { expect(note.doc.get('retryAfter')).toBe(deadline); expect(note.body).toBe(parseNote(initial).body); }
  });

  it('rejects an invalid expected URL, even when the current note is valid', async () => {
    const store = new MemoryStore({ [path]: initial }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const pending = outcome === 'success' ? repo.saveContent(path, live, { expectedUrl: '' }) :
      repo.setArticleError(path, 'Must not persist', deadline, { expectedUrl: '' });
    await expect(pending).rejects.toBeInstanceOf(StaleArticleWriteError);
    expect(await store.read(path)).toBe(initial);
  });
});

describe('true no-op versus intentional protection', () => {
  it.each([false, true])('does not assign an ID to an already-protected source veto (URL precondition=%s)', async guarded => {
    const raw = initial.replace('status: later', 'status: later\r\ncontent: protected');
    const store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const result = await repo.saveContent(path, live, guarded ? { expectedUrl: requestedUrl } : undefined);
    expect(result.content).toBe('protected');
    expect(await store.read(path)).toBe(raw);
    expect(parseNote(await readNoteRaw(store, path)).doc.has('id')).toBe(false);
  });

  it.each([false, true])('preserves a no-ID late protection pin (URL also changed=%s)', async changedUrl => {
    const store = new DelayedStore({ [path]: initial }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const task = repo.saveContent(path, live, { expectedUrl: requestedUrl, allowFeedReplacement: true })
      .then(value => ({ value }), error => ({ error }));
    await store.entered.promise;
    let latest = initial.replace('status: later', 'status: later\r\ncontent: protected');
    if (changedUrl) latest = latest.replace(requestedUrl, 'https://example.com/new-request');
    await store.externalEdit(latest); store.resume.release();
    const settled = await task;
    if (changedUrl) { expect(settled).toHaveProperty('error'); if ('error' in settled) expect(settled.error).toBeInstanceOf(StaleArticleWriteError); }
    else { expect(settled).toHaveProperty('value'); if ('value' in settled) expect(settled.value.content).toBe('protected'); }
    expect(await store.read(path)).toBe(latest); expect(store.committedChanges).toBe(0);
  });

  it('discards all tentative changes when a no-ID mutation explicitly returns false', async () => {
    const store = new MemoryStore({ [path]: initial }), context = new StorageContext(store, DEFAULT_SETTINGS);
    await context.mutate(path, 'article', note => { note.doc.set('error', 'Tentative, discarded'); return false; });
    expect(await store.read(path)).toBe(initial);
  });

  it('still persists intentional authored-source protection while preserving the entire body', async () => {
    const raw = initial.replace('## Article\r\n\r\n', '## Article\r\n\r\nAuthored source, not acquired text.\r\n\r\n');
    const store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const result = await repo.saveContent(path, live, { expectedUrl: requestedUrl, allowFeedReplacement: true });
    expect(result.content).toBe('protected'); expect(result.error).toContain('Snapshot protected:');
    const note = parseNote(await readNoteRaw(store, path));
    expect(note.body).toBe(parseNote(raw).body); expect(note.doc.has('id')).toBe(false);
    expect(note.doc.has('retryAfter')).toBe(false);
  });
});
