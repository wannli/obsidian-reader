import { mark } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ExtractedArticle } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';

const live: ExtractedArticle = { title: 'Publisher title', markdown: '# Full article\n\nExtracted publisher text.\n', status: 'ready', extractor: 'defuddle' };
const dummy: ExtractedArticle = { title: 'Sample', markdown: '# Dummy article — sample content\n\nThis is deterministic sample text, not fetched from the URL.', status: 'ready', extractor: 'dummy' };
const quickAdd = (source = '', extra = '') => '---\ncreated-by: ai\ntype: article\nstatus: inbox\nurl: https://example.com/captured\ncustom: [preserve, me]\n' + extra + '---\n## Article\n\n' + source + (source ? '\n\n' : '') + '## Comments\n\nPersonal writing.\n\n## Tasks\n- [ ] My task\n';

describe('extraction source contract', () => {
  it.each([undefined, 'My explicit capture title'])('retains live publisher titles while preserving explicit titles (%s)', async title => {
    const original = quickAdd('', title ? `title: ${title}\npublished: unknown\n` : '');
    for (const result of [dummy, live]) {
      const store = new MemoryStore({ '20261009 Capture.md': original });
      const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
      const saved = await repo.saveContent('20261009 Capture.md', result);
      const expectedTitle = title ?? (result.extractor === 'defuddle' ? live.title : undefined);
      expect(saved.title).toBe(expectedTitle ?? '20261009 Capture');
      expect(saved.path).toBe('20261009 Capture.md');
      const note = parseNote(await store.read(saved.path));
      expect(note.doc.has('title')).toBe(expectedTitle !== undefined);
      expect(note.doc.get('title')).toBe(expectedTitle);
      const restarted = new ReaderRepository(new MemoryStore(store.snapshot()), DEFAULT_SETTINGS);
      expect((await restarted.getArticle(saved.path)).title).toBe(saved.title);
      if (title) {
        expect(note.doc.get('title')).toBe(title);
        expect(note.doc.get('published')).toBe('unknown');
      }
      expect(note.body.split('## Comments')[1]).toBe(original.split('## Comments')[1]);
    }
  });

  it.each(['title: ""\n', 'title: "   "\n', 'title:\n'])('fills blank YAML titles from successful partial Defuddle results (%s)', async extra => {
    const store = new MemoryStore({ 'Capture.md': quickAdd('', extra) });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const saved = await repo.saveContent('Capture.md', { ...live, title: '  Publisher title  ', status: 'partial' });
    expect(saved.title).toBe(live.title);
    expect(parseNote(await store.read(saved.path)).doc.get('title')).toBe(live.title);
  });

  it('protects an authored heading before Article instead of treating the entire note as empty source', async () => {
    const original = quickAdd().replace('## Article', '# My capture\n\n## Article');
    const store = new MemoryStore({ 'Capture.md': original }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const saved = await repo.saveContent('Capture.md', live);
    expect(saved.body).toContain('# My capture');
    expect(saved.body).not.toContain(live.markdown);
    expect(await store.read('Capture.md')).toContain('Personal writing.');
  });

  it('does not persist blank extracted titles or titles from rejected source replacement', async () => {
    const store = new MemoryStore({ 'Blank.md': quickAdd(), 'Protected.md': quickAdd('', 'content: protected\n') });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await repo.saveContent('Blank.md', { ...live, title: '   ' });
    await repo.saveContent('Protected.md', live);
    for (const path of ['Blank.md', 'Protected.md']) expect(parseNote(await store.read(path)).doc.has('title')).toBe(false);
  });

  it('preserves a human title added after extraction started', async () => {
    const store = new MemoryStore({ 'Capture.md': quickAdd() });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await repo.getArticle('Capture.md');
    await store.process('Capture.md', raw => raw.replace('type: article', 'type: article\ntitle: My late title'));
    const saved = await repo.saveContent('Capture.md', live);
    expect(saved.title).toBe('My late title');
    expect(parseNote(await store.read(saved.path)).doc.get('title')).toBe('My late title');
  });

  it('parses the same guarded source, links, retry state and comments identically after restart', async () => {
    const store = new MemoryStore({ 'Capture.md': quickAdd() });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await repo.saveContent('Capture.md', dummy);
    const saved = await mark(repo, 'Capture.md', { quote: 'deterministic sample text' });
    await repo.setHighlightLink('Capture.md', saved.highlights[0].id, 'Notes/Source');
    await repo.setArticleError('Capture.md', 'Connection interrupted', '2030-01-01T00:00:00Z');
    const before = await repo.getArticle('Capture.md'), files = store.snapshot();
    const restored = new MemoryStore(files), restarted = new ReaderRepository(restored, DEFAULT_SETTINGS);
    expect(await restarted.getArticle('Capture.md')).toEqual(before);
    expect(before.body).toBe(dummy.markdown.replace('deterministic sample text', '[[Notes/Source|deterministic sample text]]'));
    expect(before.body).not.toContain('Personal writing.');
    expect(restored.snapshot()).toEqual(files);
  });
  it('persists a pending URL stub immediately and preserves durable errors/backoff after restart', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const stub = await repo.createArticle({ title: 'Offline capture', url: 'https://example.com/offline' });
    expect(stub).toMatchObject({ body: '', status: 'inbox' });
    for (const key of ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength']) expect(parseNote(await store.read(stub.path)).doc.has(key)).toBe(false);
    expect(DEFAULT_SETTINGS.useDummyContent).toBe(true);
    await repo.setArticleError(stub.path, 'Offline', '2030-01-02T03:04:05Z');
    const restored = new ReaderRepository(new MemoryStore(store.snapshot()), DEFAULT_SETTINGS);
    expect(await restored.getArticle(stub.path)).toMatchObject({ error: 'Offline', retryAfter: '2030-01-02T03:04:05Z' });
    const saved = await restored.saveContent(stub.path, dummy);
    expect(saved).toMatchObject({ body: dummy.markdown });
    expect(saved.error).toBeUndefined(); expect(saved.retryAfter).toBeUndefined();
  });

  it('autodetects native QuickAdd headings without extractor, ID or articleSection flags', async () => {
    const original = quickAdd(), store = new MemoryStore({ 'Reading/Inbox/Capture.md': original });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const [pending] = await repo.listArticles();
    expect(pending).toMatchObject({ body: '', id: '' });
    const saved = await repo.saveContent(pending.path, live);
    expect(saved).toMatchObject({ body: live.markdown });
    expect(parseNote(await store.read(saved.path)).doc.has('id')).toBe(false);
    const raw = await store.read(pending.path);
    expect(raw.slice(raw.indexOf('## Comments'))).toBe(original.slice(original.indexOf('## Comments')));
    expect(parseNote(raw).doc.toJS().custom).toEqual(['preserve', 'me']);
    expect(raw).toContain('## Article');
    expect(raw).not.toMatch(/<!--|reader-start|reader-end/);
  });

  it('uses latest Comments during process, preserving concurrent writing outside the source region', async () => {
    class WritingStore extends MemoryStore {
      changed = false;
      override async process(path: string, update: (current: string) => string): Promise<void> {
        return super.process(path, current => {
          if (path.endsWith('.md') && !this.changed) {
            this.changed = true; current = current.replace('Personal writing.', 'Personal writing.\nI added this while acquisition was running.');
          }
          return update(current);
        });
      }
    }
    const store = new WritingStore({ 'Capture.md': quickAdd() }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect((await repo.getArticle('Capture.md')).body).toBe('');
    const saved = await repo.saveContent('Capture.md', dummy);
    expect(saved.body).toBe(dummy.markdown);
    expect(await store.read('Capture.md')).toContain('Personal writing.\nI added this while acquisition was running.');
    expect(await store.read('Capture.md')).toContain('## Tasks\n- [ ] My task');
  });

  it.each([
    { text: quickAdd('', 'summary: A short feed teaser\n'), body: '', source: 'summary' },
    { text: quickAdd('A short feed teaser', 'summary: A short feed teaser\n'), body: 'A short feed teaser', source: 'summary' },
    { text: quickAdd('A short feed teaser', 'extractor: summary\n'), body: 'A short feed teaser', source: 'manual' },
  ])('recognizes summary classification independently of body length ($body)', async ({ text, body, source }) => {
    const store = new MemoryStore({ 'Summary.md': text }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect(await repo.getArticle('Summary.md')).toMatchObject({ body, extractor: source });
    const saved = await repo.saveContent('Summary.md', live);
    expect(saved.body).toBe(source === 'summary' ? live.markdown : body);
    if (source === 'manual') expect(saved.error).toMatch(/protected/i);
    expect((await store.read('Summary.md')).split('## Comments')[1]).toBe(text.split('## Comments')[1]);
  });

  it('preserves nonempty feed summaries without independent source ownership, including appended personal sections', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const summary = await repo.createArticle({ title: 'Feed item', url: 'https://example.com/feed-item', status: 'feed', body: 'A feed summary.', extractor: 'summary', content: 'ready' });
    const personal = '\n\n## Personal notes\nThis is my own writing.\n';
    await store.process(summary.path, raw => raw + personal);
    const saved = await repo.saveContent(summary.path, live);
    expect(saved.status).toBe('feed');
    expect(saved.body).toContain('A feed summary.'); expect(saved.body.endsWith(personal)).toBe(true);
    expect(saved.body).not.toContain(live.markdown);
  });

  it('preserves non-matching dummy-like text instead of assuming replaceable ownership', async () => {
    const store = new MemoryStore({ 'Capture.md': quickAdd() }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await repo.saveContent('Capture.md', dummy);
    const firstBody = (await repo.getArticle('Capture.md')).body;
    await repo.saveContent('Capture.md', { ...dummy, markdown: 'A different sample must not replace the cached one.' });
    const saved = await repo.saveContent('Capture.md', live);
    expect(saved.body).toBe(firstBody);
    expect(saved.error).toMatch(/protected/i);
    expect(parseNote(await store.read('Capture.md')).doc.has('content')).toBe(false);
    expect(await store.read('Capture.md')).toContain('Personal writing.');
    const protectedBody = (await repo.getArticle('Capture.md')).body;
    await repo.saveContent('Capture.md', { ...live, markdown: 'Another publisher version' });
    expect((await repo.getArticle('Capture.md')).body).toBe(protectedBody);
  });

  it('keeps repeated QuickAdd URL captures distinct instead of treating import dedupe as a write/merge', async () => {
    const store = new MemoryStore({ 'Reading/Inbox/One.md': quickAdd(), 'Reading/Inbox/Two.md': quickAdd().replace('Personal writing.', 'Second capture comments.') });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect(await repo.listArticles()).toHaveLength(2);
    const one = await repo.saveContent('Reading/Inbox/One.md', dummy), two = await repo.saveContent('Reading/Inbox/Two.md', dummy);
    expect(one.path).not.toBe(two.path);
    expect(parseNote(await store.read(one.path)).doc.has('id')).toBe(false);
    expect(parseNote(await store.read(two.path)).doc.has('id')).toBe(false);
    expect(await store.read('Reading/Inbox/One.md')).toContain('Personal writing.');
    expect(await store.read('Reading/Inbox/Two.md')).toContain('Second capture comments.');
  });
});
