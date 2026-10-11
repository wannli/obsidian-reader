import { readNoteRaw } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS as BASE_SETTINGS, type ArticleStatus } from '../src/types';
const DEFAULT_SETTINGS = BASE_SETTINGS;
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';

const queues: [ArticleStatus, string][] = [
  ['inbox', 'Inbox'], ['later', 'Later'], ['feed', 'Stream'], ['archive', 'Treasury'],
];
const note = (status = 'archive') => `---\ntype: article\nurl: https://example.com/article\nstatus: ${status}\n# Keep this comment\ncustom: &prefs\n  rating: 5\ncopy: *prefs\n---\n## Article\n\nAuthored source.\n\n## Comments\nPersonal writing.\n`;
function fixture(files: Record<string, string>) {
  const store = new MemoryStore(files);
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  return { store, repo };
}

describe('folder-authoritative article queues', () => {
  it.each(queues)('%s wins over contradictory YAML in direct and nested files', async (status, folder) => {
    const conflicting = status === 'archive' ? 'inbox' : 'archive';
    const paths = [`Reading/${folder}/261009 Article.md`, `Reading/${folder}/Nested/261009 Article.md`];
    const { store, repo } = fixture(Object.fromEntries(paths.map(path => [path, note(conflicting)])));
    const before = store.snapshot();
    expect((await repo.listArticles()).map(article => [article.path, article.status])).toEqual(paths.map(path => [path, status]));
    for (const path of paths) expect((await repo.getArticle(path)).status).toBe(status);
    expect(store.snapshot()).toEqual(before);
  });

  it.each(['Reading/Inbox-old/A.md', 'Reading/InboxExtra/A.md', 'Elsewhere/Reading/Inbox/A.md', 'Reading/Inbox.md', 'Reading/Wires/A.md'])(
    'keeps explicitly typed articles readable but unqueued outside canonical folders: %s', async path => {
      const { store, repo } = fixture({ [path]: note() });
      expect(await repo.listArticles()).toEqual([]);
      await expect(repo.getArticle(path)).resolves.toMatchObject({ status: undefined });
      expect(await store.read(path)).toBe(note());
    },
  );

  it('keeps explicit nonarticles and configured templates out of queues', async () => {
    const files = {
      'Reading/Inbox/Topic.md': note().replace('url:', 'type: topic\nurl:'),
      'Reading/Wires/Wired.md': note().replace('type: article\n', 'type: feed\n'),
      'Reading/Inbox/Templates/Article.md': note().replace('url:', 'type: article\nurl:'),
    };
    const store = new MemoryStore(files), repo = new ReaderRepository(store, DEFAULT_SETTINGS, { folders: ['Reading/Inbox/Templates'] });
    expect(await repo.listArticles()).toEqual([]);
    expect((await repo.listFeeds()).map(feed => feed.path)).toEqual(['Reading/Wires/Wired.md']);
    expect(store.snapshot()).toEqual(files);
  });

  it('keeps typed articles outside canonical queues readable but unqueued, ignoring YAML status', async () => {
    const files = {
      'Elsewhere/Manual.md': '---\ntype: article\nstatus: later\ncustom: keep\n---\nMy manual source.\n',
      'Reading/Articles/Legacy.md': note('archive'),
    };
    const { store, repo } = fixture(files);
    expect(await repo.listArticles()).toEqual([]);
    await expect(repo.getArticle('Elsewhere/Manual.md')).resolves.toMatchObject({ status: undefined, url: '' });
    await expect(repo.getArticle('Reading/Articles/Legacy.md')).resolves.toMatchObject({ status: undefined });
    expect(store.snapshot()).toEqual(files);
  });

  it.each(queues)('creates %s notes in the canonical folder without status YAML', async (status, folder) => {
    const { store, repo } = fixture({});
    const article = await repo.createArticle({ title: 'New note', url: '', status });
    expect(article.path.startsWith(`Reading/${folder}/`)).toBe(true);
    expect(article.status).toBe(status);
    expect(parseNote(await readNoteRaw(store, article.path)).doc.has('status')).toBe(false);
  });

  it('moves only the queue while preserving dated basename, unknown YAML, and the complete body', async () => {
    const path = 'Reading/Inbox/240101 Old article.md', raw = note('archive');
    const { store, repo } = fixture({ [path]: raw });
    const moved = await repo.setStatus(path, 'later');
    expect(moved.path).toBe('Reading/Later/240101 Old article.md');
    expect(moved.status).toBe('later');
    expect(await store.exists(path)).toBe(false);
    const next = await store.read(moved.path), parsed = parseNote(next);
    expect(parsed.body).toBe(parseNote(raw).body);
    expect(next).toBe(raw); // Even contradictory legacy status is preserved; the folder wins.
    expect(next).toContain('# Keep this comment');
    expect(parsed.doc.toJS()).toMatchObject({ custom: { rating: 5 }, copy: { rating: 5 } });
    const archived = await repo.setStatus(moved.path, 'archive');
    expect(archived.path).toBe('Reading/Treasury/240101 Old article.md');
    expect(parseNote(await readNoteRaw(store, archived.path)).body).toBe(parsed.body);
  });

  it('refuses a move collision rather than changing the basename or overwriting another note', async () => {
    const path = 'Reading/Inbox/240101 Old article.md', target = 'Reading/Later/240101 Old article.md';
    const { store, repo } = fixture({ [path]: note(), [target]: 'Unrelated writing.' });
    const before = store.snapshot();
    await expect(repo.setStatus(path, 'later')).rejects.toThrow();
    expect(store.snapshot()).toEqual(before);
  });

  it('retains repeated externally captured URLs as distinct notes', async () => {
    const paths = ['Reading/Inbox/261009 Capture.md', 'Reading/Inbox/261009 Capture-2.md'];
    const files = Object.fromEntries(paths.map((path, index) => [path, note('inbox').replace('Personal writing.', `Capture ${index + 1}.`)]));
    const { store, repo } = fixture(files);
    expect((await repo.listArticles()).map(article => article.path)).toEqual([...paths].sort());
    expect(store.snapshot()).toEqual(files);
  });
});

describe('legacy queue-move intent is retained, never silently repaired', () => {
  it.each(['Reading/Inbox/Legacy.md', 'Reading/Later/Legacy.md'])('blocks pending intent at %s without touching journals', async path => {
    const raw = note().replace('status: archive', 'status: archive\nqueueMove: {version: 1, from: Reading/Inbox/Legacy.md, to: Reading/Later/Legacy.md}');
    const { store, repo } = fixture({ [path]: raw, 'Daily/old.md': 'Edited journal with [[Legacy#^hl-old]]' });
    const before = store.snapshot();
    await expect(repo.setStatus(path, 'archive')).rejects.toThrow();
        expect(store.snapshot()).toEqual(before);
  });
});
