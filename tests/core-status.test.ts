import { describe, expect, it, vi } from 'vitest';
import { articleInfo, queues } from '../src/core/model';
import { ArticleStore } from '../src/core/store';
import { createDocument, patchProperties, readDocument, savePosition } from '../src/core/document';
import { MemoryVault } from './helpers/memory-vault';
import { queueForPath, defaultStatusFolders } from '../src/core/status-folders';

const now = new Date('2026-10-15T12:00:00Z');
async function fixture(status: Record<string, unknown> = {}) {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const properties = { type: 'article', published: '2026-01-01', ...status };
  const file = await vault.create(
    'Reading/Stream/260101 Article.md',
    createDocument(properties, 'Article words.'),
  );
  store.catalog.update(file.path, properties);
  return { vault, store, file, snapshot: await store.read(file.path) };
}

describe('folder queue authority and YAML mirror', () => {
  it('uses the four display queues and lowercase persisted values', () => {
    expect(queues).toEqual(['Inbox', 'Later', 'Feed', 'Archive']);
    for (const [status, queue] of [
      ['inbox', 'Inbox'],
      ['later', 'Later'],
      ['feed', 'Feed'],
      ['archive', 'Archive'],
    ]) {
      const path = `${defaultStatusFolders[status as keyof typeof defaultStatusFolders]}/article.md`;
      const info = articleInfo(
        path,
        { type: 'article', status },
        queueForPath(path, defaultStatusFolders),
      );
      expect(info?.status).toBe(status);
      expect(info?.queue).toBe(queue);
    }
  });
  it('folder membership wins over absent or contradictory YAML, while status stays a mirror', () => {
    expect(queueForPath('Reading/Inbox/a.md', defaultStatusFolders)).toBe('Inbox');
    expect(queueForPath('Elsewhere/a.md', defaultStatusFolders)).toBeUndefined();
    expect(articleInfo('Reading/Inbox/a.md', { type: 'article' }, 'Inbox')?.queue).toBe('Inbox');
    expect(
      articleInfo('Reading/Inbox/a.md', { type: 'article', status: 'feed' }, 'Inbox')?.queue,
    ).toBe('Inbox');
    expect(articleInfo('Reading/Inbox/a.md', { type: 'article' }, 'Inbox')?.status).toBeUndefined();
  });
  it.each([undefined, null, '', 'Feed', 'INBOX', 'unknown', [], {}, 0, false])(
    'keeps invalid YAML status %j out of the mirror without losing Inbox membership',
    (status) => {
      const info = articleInfo('Reading/Inbox/a.md', { type: 'article', status }, 'Inbox');
      expect(info?.queue).toBe('Inbox');
      expect(info?.status).toBeUndefined();
    },
  );
  it.each([
    {},
    { status: null },
    { status: '' },
    { status: 'unknown' },
    { status: 'inbox' },
    { status: 'later' },
    { status: 'archive' },
  ])('never expires protected status %j', async (status) => {
    const f = await fixture(status);
    const read = vi.spyOn(f.vault, 'read');
    expect(await f.store.expire(now)).toEqual({ deleted: 0, retained: 0, promoted: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(f.vault.trashed).toEqual([]);
  });
  it.each([{}, { status: null }, { status: '' }, { status: 'later' }])(
    'rejects stale feed metadata when fresh status is %j',
    async (status) => {
      const f = await fixture(status);
      f.store.catalog.update(f.file.path, {
        type: 'article',
        status: 'feed',
        published: '2026-01-01',
      });
      await f.store.expire(now);
      expect(f.vault.trashed).toEqual([]);
      expect(await f.vault.read(f.file)).toBe(f.snapshot.raw);
    },
  );
  it.each([null, '', 'later', 'archive'])(
    'rejects a final-boundary status change to %j',
    async (status) => {
      const f = await fixture({ status: 'feed' });
      f.vault.beforeTrash = async () => {
        f.vault.bytes.set(f.file, patchProperties(f.snapshot.raw, { status }));
      };
      expect(await f.store.expire(now)).toEqual({ deleted: 0, retained: 1, promoted: 0 });
      expect(f.vault.trashed).toEqual([]);
      expect(readDocument(await f.vault.read(f.file)).properties.status).toBe(status);
    },
  );
  it.each([
    {},
    { status: 'feed' },
    { status: 'inbox' },
    { status: 'later' },
    { status: 'archive' },
    { status: null },
  ])('annotating a Stream article moves it to Later and mirrors status: %j', async (status) => {
    const f = await fixture(status);
    const process = f.vault.process.bind(f.vault);
    const seen: Record<string, unknown>[] = [];
    f.vault.process = async (file, update) => {
      const raw = await process(file, update);
      seen.push(readDocument(raw).properties);
      return raw;
    };
    const saved = await f.store.annotate(f.snapshot, (raw) =>
      raw.replace('Article words.', '==Article words.=='),
    );
    expect(saved.properties.status).toBe('later');
    expect(seen).toHaveLength(status.status === 'later' ? 1 : 2);
    expect(seen[0].status).toBe('later');
    expect(f.file.path).toBe('Reading/Later/260101 Article.md');
  });
  it('failed native/synced annotation promotion is retained, never trashed', async () => {
    const f = await fixture({ status: 'feed' });
    f.vault.bytes.set(f.file, f.snapshot.raw.replace('Article words.', '==Article words.=='));
    f.vault.failWrite = true;
    expect(await f.store.expire(now)).toEqual({ deleted: 0, retained: 1, promoted: 0 });
    expect(f.vault.trashed).toEqual([]);
    expect(readDocument(await f.vault.read(f.file)).properties.status).toBe('feed');
  });
});

it('changes only status, preserving comments, unknown YAML, bookmark and placement', async () => {
  const f = await fixture({
    status: 'feed',
    bookmark: 'Article words.',
    reading_position: { old: true },
  });
  const raw =
    '---\ntype: article\nstatus: feed # state comment\ncustom: &custom [one, two] # authored\ncopy: *custom\nbookmark: Article words.\nreading_position: {old: true}\n---\n## Authored\n\nArticle words.\n';
  f.vault.bytes.set(f.file, raw);
  const saved = await f.store.move(await f.store.read(f.file.path), 'Archive');
  expect(saved.path).toBe('Reading/Treasury/260101 Article.md');
  expect(saved.body).toBe(readDocument(raw).body);
  expect(saved.properties).toEqual({ ...readDocument(raw).properties, status: 'archive' });
  expect(saved.raw).toContain('# state comment');
  expect(saved.raw).toContain('# authored');
});

it('reading and saving a bookmark never add a missing status', async () => {
  const f = await fixture();
  expect((await f.store.read(f.file.path)).raw).toBe(f.snapshot.raw);
  const saved = await f.store.position(f.file.path, 'Article words.');
  expect(saved.properties).not.toHaveProperty('status');
  expect(saved.properties.bookmark).toBe('Article words.');
  expect(f.store.catalog.article(f.file.path)?.queue).toBe('Feed');
  expect(f.store.catalog.article(f.file.path)?.status).toBeUndefined();
});

describe('bookmark only, without legacy conversion', () => {
  it('preserves old malformed reading_position as unknown while writing bookmark', () => {
    const raw = createDocument(
      { type: 'article', reading_position: { unknown: ['old'] }, status: 'feed' },
      'Body',
    );
    const saved = readDocument(savePosition(raw, 'Body'));
    expect(saved.properties).toEqual({
      type: 'article',
      reading_position: { unknown: ['old'] },
      bookmark: 'Body',
      status: 'feed',
    });
    expect(readDocument(savePosition(saved.raw, '')).properties).not.toHaveProperty('bookmark');
    expect(saved.body).toBe('Body');
  });
});
