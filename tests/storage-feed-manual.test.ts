import { mark } from './markdown-helpers';
import { readNoteRaw, rawStore } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote, writeNote } from '../src/storage/markdown';
import { fingerprint } from '../src/storage/fingerprint';
import { dummyArticle } from '../src/ingest/dummy';

const url = 'https://example.com/full-feed';
const markdown = 'Original full feed text.';
const live = { title: 'Different web title', markdown: 'Explicit live replacement.', status: 'ready' as const, extractor: 'defuddle' as const };
async function fixture(store = new MemoryStore()) {
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Publisher title', url, feedText: { markdown, isExcerpt: false } });
  return { store, repo, article };
}

describe('explicit selected-article live replacement of full feed text', () => {
  it('protects unstamped full feed text even from explicit live replacement after restart', async () => {
    const { store, repo, article } = await fixture(), before = await store.read(article.path);
    await repo.saveContent(article.path, live);
    expect(parseNote(await store.read(article.path)).body).toBe(parseNote(before).body);
    const restarted = new ReaderRepository(store, DEFAULT_SETTINGS);
    const result = await restarted.saveContent(article.path, live, { allowFeedReplacement: true });
    expect(result).toMatchObject({ path: article.path, title: 'Publisher title', extractor: 'manual', content: 'protected', body: markdown });
    expect(parseNote(await store.read(article.path)).body).toBe(parseNote(before).body);
    expect(DEFAULT_SETTINGS.useDummyContent).toBe(true);
    expect(parseNote(before).doc.has('allowFeedReplacement')).toBe(false);
  });

  it('never permits dummy replacement even when the manual-feed option is passed', async () => {
    const { store, repo, article } = await fixture(), before = await store.read(article.path);
    await repo.saveContent(article.path, dummyArticle(url), { allowFeedReplacement: true });
    expect(parseNote(await store.read(article.path)).body).toBe(parseNote(before).body);
  });

  it('preserves Comments, custom sections, raw status and topics without trusting historical extraction stamps', async () => {
    const { store, repo, article } = await fixture();
    await rawStore(store).process(article.path, raw => {
      const note = parseNote(raw), prefix = '\n' + markdown + '\n\n';
      note.body = '## Article\n' + prefix + '## Comments\n\nMy comments.\n\n## Other\n\nKeep this.\n';
      note.doc.set('articleSection', 'Article'); note.doc.set('extractor', 'feed'); note.doc.set('sourceHash', fingerprint(prefix)); note.doc.set('sourceLength', prefix.length);
      note.doc.set('topics', note.doc.createNode(['[[Topics/Existing|Alias]]'])); note.doc.set('custom', 'keep'); note.doc.set('status', 'later');
      return writeNote(note);
    });
    const result = await repo.saveContent(article.path, live, { allowFeedReplacement: true });
    const note = parseNote(await readNoteRaw(store, article.path));
    expect(result.body).toBe(markdown); expect(result.title).toBe('Publisher title'); expect(result.status).toBe('inbox');
    expect(note.doc.get('status')).toBe('later'); // Unrelated extraction must not rewrite stale user metadata.
    expect(note.body).toContain('## Comments\n\nMy comments.\n\n## Other\n\nKeep this.\n');
    expect(note.doc.get('custom')).toBe('keep'); expect(note.doc.toJS().topics).toEqual(['[[Topics/Existing|Alias]]']);
  });

  it.each(['protected', 'edited', 'highlighted'] as const)('does not bypass %s protection', async state => {
    const { store, repo, article } = await fixture();
    if (state === 'protected') await rawStore(store).process(article.path, raw => { const note = parseNote(raw); note.doc.set('content', 'protected'); return writeNote(note); });
    if (state === 'edited') await store.process(article.path, raw => raw.replace(markdown, 'Authored replacement text.'));
    if (state === 'highlighted') await mark(repo, article.path, { quote: markdown });
    const body = parseNote(await readNoteRaw(store, article.path)).body;
    const result = await repo.saveContent(article.path, live, { allowFeedReplacement: true });
    expect(result.content).toBe('protected');
    expect(parseNote(await readNoteRaw(store, article.path)).body).toBe(body);
  });

  it('vetoes an explicit manual result when protection arrives at the latest process boundary', async () => {
    class LateStore extends MemoryStore {
      protect = false; protectedRaw = '';
      override async process(path: string, update: (current: string) => string): Promise<void> {
        if (this.protect) {
          this.protect = false;
          await super.process(path, raw => { const note = parseNote(raw); note.doc.set('content', 'protected'); note.doc.set('error', 'Pinned during fetch'); this.protectedRaw = writeNote(note); return this.protectedRaw; });
        }
        return super.process(path, update);
      }
    }
    const store = new LateStore(), { repo, article } = await fixture(store);
    store.protect = true;
    expect((await repo.saveContent(article.path, live, { allowFeedReplacement: true })).content).toBe('protected');
    expect(await store.read(article.path)).toBe(store.protectedRaw);
  });

  it('vetoes a late automatic result when latest content has become full feed text', async () => {
    class LateStore extends MemoryStore {
      inject = false; fullRaw = '';
      override async process(path: string, update: (current: string) => string): Promise<void> {
        if (this.inject) {
          this.inject = false;
          await super.process(path, raw => {
            const note = parseNote(raw); note.body = markdown; note.doc.set('extractor', 'feed'); note.doc.set('content', 'ready');
            note.doc.set('sourceHash', fingerprint(markdown)); note.doc.set('sourceLength', markdown.length);
            this.fullRaw = writeNote(note); return this.fullRaw;
          });
        }
        return super.process(path, update);
      }
    }
    const store = new LateStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const pending = await repo.createArticle({ title: 'Publisher title', url });
    store.inject = true;
    expect((await repo.saveContent(pending.path, live)).extractor).toBe('manual');
    expect(parseNote(await store.read(pending.path)).body).toBe(parseNote(store.fullRaw).body);
  });

  it('does not use the flag to overwrite manual authorship or bypass invalid URL guards', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const manual = await repo.createArticle({ title: 'My writing', url, body: 'Authored source.' });
    expect((await repo.saveContent(manual.path, live, { allowFeedReplacement: true })).content).toBe('protected');
    expect(parseNote(await readNoteRaw(store, manual.path)).body).toBe('Authored source.');
    const { store: fullStore, repo: fullRepo, article } = await fixture();
    await fullStore.process(article.path, raw => { const note = parseNote(raw); note.doc.set('url', '{{VALUE:url}}'); return writeNote(note); });
    const before = fullStore.snapshot();
    await expect(fullRepo.saveContent(article.path, live, { allowFeedReplacement: true })).rejects.toThrow();
    expect(fullStore.snapshot()).toEqual(before);
  });

  it('does not use the manual option to fill a full-feed note whose URL was removed', async () => {
    const { store, repo, article } = await fixture();
    await rawStore(store).process(article.path, raw => { const note = parseNote(raw); note.doc.delete('url'); return writeNote(note); });
    const before = await store.read(article.path);
    await repo.saveContent(article.path, live, { allowFeedReplacement: true });
    expect(parseNote(await store.read(article.path)).body).toBe(parseNote(before).body);
  });
});
