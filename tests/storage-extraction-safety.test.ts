import { parseInlineMarkdown } from '../src/inline';
import { mark } from './markdown-helpers';
import { readNoteRaw, rawStore, noteMetadata } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS as BASE_SETTINGS, type ExtractedArticle } from '../src/types';
const DEFAULT_SETTINGS = BASE_SETTINGS;
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote, writeNote } from '../src/storage/markdown';
import { dummyArticle } from '../src/ingest/dummy';

const dummy = dummyArticle('https://example.com/capture');
const live: ExtractedArticle = { title: 'Live', markdown: '# Live article\n\nReal publisher text.', status: 'ready', extractor: 'defuddle' };
const capture = (source = '', extra = '') => '---\ntype: article\nurl: https://example.com/capture\n' + extra + '---\n## Article\n\n' + source + (source ? '\n\n' : '') + '## Comments\n\nPersonal thoughts.\n';

describe('snapshot ownership and extraction protection', () => {
  it('leaves a directly protected hash-valid dummy snapshot completely unchanged', async () => {
    const store = new MemoryStore({ 'Capture.md': capture('', 'custom: [keep, this]\n# Keep this YAML comment\n') });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await repo.saveContent('Capture.md', dummy);
    await rawStore(store).process('Capture.md', raw => {
      const note = parseNote(raw);
      note.doc.set('content', 'protected');
      note.doc.set('error', 'Explicitly pinned by the reader');
      note.doc.set('retryAfter', '2030-01-01T00:00:00Z');
      return writeNote(note);
    });
    const before = store.snapshot(), article = await repo.getArticle('Capture.md');
    const saved = await repo.saveContent('Capture.md', live);
    expect(saved).toEqual(article);
    expect(store.snapshot()).toEqual(before);
  });

  it('vetoes in-flight dummy-to-live completion when the latest process content becomes protected', async () => {
    class ProtectingStore extends MemoryStore {
      protectNext = false;
      protectedNote = '';
      override async process(path: string, update: (current: string) => string): Promise<void> {
        if (this.protectNext) {
          this.protectNext = false;
          await super.process(path, current => {
            const note = parseNote(current);
            note.doc.set('content', 'protected');
            note.doc.set('error', 'Pinned while extraction was running');
            note.doc.set('custom', note.doc.createNode({ pinned: true, keep: ['personal', 'metadata'] }));
            note.body = note.body.replace('Personal thoughts.', 'Personal thoughts.\nNew writing during the request.');
            this.protectedNote = writeNote(note);
            return this.protectedNote;
          });
        }
        return super.process(path, update);
      }
    }
    const store = new ProtectingStore({ 'Capture.md': capture() }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const earlier = await repo.saveContent('Capture.md', dummy);
    expect(earlier.content).toBe('ready');
    expect(parseNote(await readNoteRaw(store, 'Capture.md')).doc.has('sourceHash')).toBe(false);
    store.protectNext = true;
    expect((await repo.saveContent('Capture.md', { ...live, status: 'partial', warning: 'A late extraction warning' })).content).toBe('protected');
    expect(await store.read('Capture.md')).toBe(store.protectedNote);
    const note = parseNote(store.protectedNote);
    expect(note.doc.get('content')).toBe('protected');
    expect(note.body).toContain(dummy.markdown);
    expect((await noteMetadata(store, 'Capture.md')).custom).toEqual({ pinned: true, keep: ['personal', 'metadata'] });
    expect(note.doc.toJS().custom).toEqual({ pinned: true, keep: ['personal', 'metadata'] });
    expect(note.body).toContain('Personal thoughts.\nNew writing during the request.');
  });

  it.each([
    '---\ntype: article\nurl: https://example.com/manual\ncontent: ready\n---\nAuthored flat Markdown.\n',
    capture('Authored Article-region text.'),
  ])('protects unknown/authored bodies without pretending ready means Defuddle completed', async raw => {
    const store = new MemoryStore({ 'Manual.md': raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect((await repo.getArticle('Manual.md')).extractor).toBe('manual');
    const result = await repo.saveContent('Manual.md', live);
    expect(result).toMatchObject({ extractor: 'manual', content: 'protected' });
    expect(result.error).toContain('authored or unknown');
    expect(parseNote(await readNoteRaw(store, 'Manual.md')).body).toBe(parseNote(raw).body);
  });

  it('allows independently verified summary text but not unlabeled nonempty stubs', async () => {
    const store = new MemoryStore({ 'Summary.md': '---\ntype: article\nsummary: A known feed teaser.\n---\nA known feed teaser.', 'Unknown.md': '---\ntype: article\n---\nA nonempty stub.' });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect((await repo.saveContent('Summary.md', live)).body).toBe(live.markdown);
    const protectedArticle = await repo.saveContent('Unknown.md', live);
    expect(protectedArticle.content).toBe('protected'); expect(protectedArticle.body).toBe('A nonempty stub.');
  });

  it('refuses dummy replacement when its tracked text was edited, while preserving comments', async () => {
    const store = new MemoryStore({ 'Capture.md': capture() }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await repo.saveContent('Capture.md', dummy);
    await store.process('Capture.md', raw => raw.replace('This is generated sample text for Reader.', 'User edited the saved source.'));
    await repo.setArticleError('Capture.md', 'Temporary problem', '2030-01-01T00:00:00Z');
    const before = parseNote(await readNoteRaw(store, 'Capture.md')).body;
    const saved = await repo.saveContent('Capture.md', live);
    expect(saved).toMatchObject({ extractor: 'manual', content: 'protected' });
    expect(saved.retryAfter).toBeUndefined(); expect(saved.error).toContain('authored or unknown');
    expect(parseNote(await readNoteRaw(store, 'Capture.md')).body).toBe(before);
  });

  it('protects writing inserted into a previously empty pending flat stub', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const stub = await repo.createArticle({ title: 'Pending', url: 'https://example.com/pending' });
    await store.process(stub.path, raw => raw + 'I began writing here while offline.');
    const saved = await repo.saveContent(stub.path, live);
    expect(saved.content).toBe('protected'); expect(saved.body).toBe('I began writing here while offline.');
  });

  it('protects highlighted dummy snapshots and all readable/native highlight blocks', async () => {
    const store = new MemoryStore({ 'Capture.md': capture() }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await repo.saveContent('Capture.md', dummy);
    const highlighted = await mark(repo, 'Capture.md', { quote: 'This is generated sample text for Reader.' });
    await repo.setHighlightLink('Capture.md', highlighted.highlights[0].id, 'My note');
    const beforeBody = parseNote(await readNoteRaw(store, 'Capture.md')).body;
    const result = await repo.saveContent('Capture.md', live);
    expect(result).toMatchObject({ content: 'protected', body: dummy.markdown.replace('This is generated sample text for Reader.', '[[My note|This is generated sample text for Reader.]]') });
    expect(parseInlineMarkdown(result.body, { stripTitle: result.title }).links[0]).toMatchObject({ quote: 'This is generated sample text for Reader.', target: 'My note' });
    expect(parseNote(await readNoteRaw(store, 'Capture.md')).body).toBe(beforeBody);
    expect(await store.exists('Daily/day.md')).toBe(false);
  });

  it('preserves full extracted Markdown headings without confusing them with surrounding note sections', async () => {
    const store = new MemoryStore({ 'Capture.md': capture() }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const markdown = '# Publisher title\n\n## Article\nA section in the publisher text.\n\n## Comments\nPublisher comments.\n\n## Highlights\nPublisher summary.\n\n~~~md\n## Article\n~~~\n';
    const saved = await repo.saveContent('Capture.md', { ...live, markdown });
    expect(saved.body).toBe(markdown);
    const before = parseNote(await readNoteRaw(store, 'Capture.md')).body;
    const marked = await mark(repo, 'Capture.md', { quote: 'Publisher summary.' });
    expect(marked.body).toBe(markdown.replace('Publisher summary.', '==Publisher summary.=='));
    const linked = await repo.setHighlightLink('Capture.md', marked.highlights[0].id, 'https://example.com/reference');
    await repo.deleteLink('Capture.md', parseInlineMarkdown(linked.body, { stripTitle: linked.title }).links[0].id);
    expect(parseNote(await readNoteRaw(store, 'Capture.md')).body).toBe(before);
  });

  it('ignores fenced template heading lookalikes while filling the real Article region', async () => {
    const source = capture().replace('## Article', '~~~md\n## Article\n## Comments\n~~~\n\n## Article');
    const store = new MemoryStore({ 'Capture.md': source }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect((await repo.getArticle('Capture.md')).body).toContain('~~~md\n## Article\n## Comments\n~~~');
    const saved = await repo.saveContent('Capture.md', live);
    expect(saved.body).toBe(live.markdown);
    expect(await store.read('Capture.md')).toContain('~~~md\n## Article\n## Comments\n~~~');
    expect(await store.read('Capture.md')).toContain('## Comments\n\nPersonal thoughts.');
  });

  it('preserves known-real snapshots even when a stale caller supplies dummy content', async () => {
    const raw = capture('# Real full text\n\nOffline snapshot.', 'extractor: defuddle\ncontent: ready\nid: existing\n');
    const store = new MemoryStore({ 'Real.md': raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await repo.saveContent('Real.md', dummy);
    const after = parseNote(await store.read('Real.md'));
    expect(after.body).toBe(parseNote(raw).body);
    expect(after.doc.get('id')).toBe('existing');
    expect(after.doc.get('extractor')).toBe('defuddle');
    expect(after.doc.get('content')).toBe('ready');
    expect(after.doc.get('error')).toContain('Snapshot protected');
  });

  it('rejects invalid retry timestamps and clears valid retry state only after successful acquisition', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const article = await repo.createArticle({ title: 'Backoff', url: 'https://example.com/retry' });
    const before = store.snapshot();
    await expect(repo.setArticleError(article.path, 'Error', 'not a timestamp')).rejects.toThrow('retry timestamp');
    expect(store.snapshot()).toEqual(before);
    await repo.setArticleError(article.path, 'Network error', '2030-01-01T00:00:00Z');
    const ready = await repo.saveContent(article.path, { ...live, status: 'partial', warning: 'Partial result' });
    expect(ready.extractor).toBe('defuddle'); expect(ready.content).toBe('partial');
    expect(ready.error).toBe('Partial result'); expect(ready.retryAfter).toBeUndefined();
  });
});
