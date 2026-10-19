// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { addHighlight, locateSelection, passages } from '../src/core/annotations';
import { readDocument, replaceBody } from '../src/core/document';
import { linkPath } from '../src/core/model';
import { ArticleStore, type NoteFile } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

// Import the actual generator, not copied fixtures. Only call its pure seedFiles
// export: no setup command, filesystem/vault writes, Obsidian, or network access.
const seedUrl = new URL('../scripts/seed.mjs', import.meta.url).href;
const seed = (await import(seedUrl)) as {
  seedFiles(day: string): Record<string, string>;
  seedTitle: string;
  seedQuote: string;
  seedBody: string;
  feedTitle: string;
};
const DAY = '2026-10-13';
const stores: ArticleStore<NoteFile>[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
});

async function library() {
  const files = seed.seedFiles(DAY),
    vault = new MemoryVault(),
    store = new ArticleStore(vault);
  stores.push(store);
  for (const [path, raw] of Object.entries(files)) {
    await vault.create(path, raw);
    if (path.endsWith('.md')) {
      const properties = /^(?:\uFEFF)?---\r?\n/.test(raw) ? readDocument(raw).properties : {};
      store.catalog.update(path, properties);
    }
  }
  return { files, vault, store };
}

describe('synthetic seed library with the current ArticleStore', () => {
  it('discovers all four queues and the disabled offline feed without indexing the journal as an article', async () => {
    const { files, vault, store } = await library();
    expect(store.catalog.size).toBe(4);
    for (const queue of ['Inbox', 'Feed', 'Later', 'Archive'] as const) {
      const articles = store.catalog.list(queue);
      expect(articles, queue).toHaveLength(1);
      expect(
        articles[0].path.startsWith(
          {
            Inbox: 'Reading/Inbox/',
            Feed: 'Reading/Stream/',
            Later: 'Reading/Later/',
            Archive: 'Reading/Treasury/',
          }[queue],
        ),
      ).toBe(true);
      const snapshot = await store.read(articles[0].path);
      expect(snapshot.properties.type).toBe('article');
      expect(snapshot.properties.status).toBe(queue.toLowerCase());
      expect(snapshot.body.trim()).not.toBe('');
      expect(snapshot.raw).toBe(files[snapshot.path]);
    }
    const inbox = store.catalog.list('Inbox')[0],
      article = await store.read(inbox.path);
    expect(inbox.title).toBe(seed.seedTitle);
    expect(article.body).toBe(seed.seedBody);
    expect(article.properties['test-note']).toBe('Preserve this unknown property');
    const feeds = store.catalog.feeds();
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({
      title: seed.feedTitle,
      enabled: false,
      url: 'https://example.invalid/reader/feed.xml',
      prefix: 'Synthetic',
    });
    expect(readDocument(await vault.read(vault.file(feeds[0].path)!)).properties.enabled).toBe(
      false,
    );
    expect(store.catalog.feeds().filter((feed) => feed.enabled)).toEqual([]);
    const feedArticle = await store.read(store.catalog.list('Feed')[0].path);
    const linkedFeed = linkPath(String(feedArticle.properties.feed));
    expect(store.catalog.feed(linkedFeed ?? '') ?? store.catalog.feed(`${linkedFeed}.md`)).toEqual(
      feeds[0],
    );
    expect(store.catalog.article(`Daily/${DAY}.md`)).toBeUndefined();
    expect(store.catalog.article('Welcome.md')).toBeUndefined();
    expect(await vault.read(vault.file(`Daily/${DAY}.md`)!)).toBe(files[`Daily/${DAY}.md`]);
  });

  it('keeps out-of-queue typed notes readable and promotes missing-status Feed annotations', async () => {
    const { vault, store } = await library();
    const raw =
      '---\ntype: article\npublished: 2001-01-01\nreading_position: legacy anchor\ncustom: keep\n---\nA synthetic passage.\n';
    const path = 'Reading/Stream/Loose article.md';
    await vault.create(path, raw);
    store.catalog.update(path, readDocument(raw).properties);
    expect(store.catalog.article(path)?.queue).toBe('Feed');
    expect(store.catalog.article(path)?.status).toBeUndefined();
    await store.expire(new Date(`${DAY}T12:00:00Z`));
    expect(await vault.read(vault.file(path)!)).toBe(raw);
    expect(vault.trashed).toEqual([]);
    const snapshot = await store.read(path);
    expect(snapshot.properties.bookmark).toBeUndefined();
    const range = locateSelection(snapshot.body, 'synthetic passage');
    const saved = await store.annotate(snapshot, (current) =>
      replaceBody(current, snapshot.body, addHighlight(snapshot.body, range.from, range.to)),
    );
    expect(saved.path).toBe('Reading/Later/Loose article.md');
    expect(saved.properties.status).toBe('later');
    expect(saved.properties.reading_position).toBe('legacy anchor');
    expect(saved.properties.custom).toBe('keep');
    expect(saved.body).toBe('A ==synthetic passage==.\n');
    store.catalog.update('Loose feed.md', { type: 'feed', url: 'https://example.invalid/rss' });
    expect(store.catalog.feed('Loose feed.md')).toBeDefined();
    store.catalog.update('Invalid status.md', { type: 'article', status: 'Stream' });
    expect(store.catalog.article('Invalid status.md')).toBeDefined();
    expect(store.catalog.article('Invalid status.md')?.queue).toBeUndefined();
  });

  it('preserves unknown seed YAML and every unrelated byte while highlighting and changing status', async () => {
    const { vault, store } = await library();
    const unrelatedDaily = 'Daily/Unrelated.md';
    const unrelatedBytes =
      '---\ndate: 2026-10-12 # authored comment\ncustom: [keep, this]\n---\n# Plans\n\nUnrelated ==journal highlight== and user text.\n';
    await vault.create(unrelatedDaily, unrelatedBytes);
    const beforeBytes = new Map(
      await Promise.all(
        [...vault.files].map(async ([path, file]) => [path, await vault.read(file)] as const),
      ),
    );
    const original = await store.read(store.catalog.list('Inbox')[0].path);
    const selection = locateSelection(original.body, seed.seedQuote);
    const body = addHighlight(original.body, selection.from, selection.to);
    const highlighted = await store.annotate(original, (raw) =>
      replaceBody(raw, original.body, body),
    );
    expect(highlighted.body).toBe(seed.seedBody.replace(seed.seedQuote, `==${seed.seedQuote}==`));
    expect(passages(highlighted.body).map((passage) => passage.text)).toEqual([seed.seedQuote]);
    expect(highlighted.properties).toEqual(original.properties);
    // Keep the exact frontmatter, not merely a reparsed value for unknown fields.
    const frontmatter = original.raw.slice(0, original.raw.length - original.body.length);
    expect(highlighted.raw.slice(0, highlighted.raw.length - highlighted.body.length)).toBe(
      frontmatter,
    );
    const moved = await store.move(highlighted, 'Later');
    expect(moved.file).toBe(original.file);
    expect(moved.path).toBe(original.path.replace('Reading/Inbox/', 'Reading/Later/'));
    expect(moved.body).toBe(highlighted.body);
    expect(moved.raw).toBe(highlighted.raw.replace('status: "inbox"', 'status: "later"'));
    expect(moved.properties.status).toBe('later');
    expect(moved.properties['test-note']).toBe('Preserve this unknown property');
    expect(store.catalog.list('Inbox')).toEqual([]);
    expect(store.catalog.list('Later')).toHaveLength(2);
    expect(vault.file(original.path)).toBeUndefined();
    expect(vault.file(moved.path)).toBe(original.file);
    expect(store.catalog.article(moved.path)?.queue).toBe('Later');
    expect([...vault.files.keys()].sort()).toEqual(
      [...beforeBytes.keys()].map((path) => (path === original.path ? moved.path : path)).sort(),
    );
    for (const [path, raw] of beforeBytes) {
      if (path !== original.path) expect(await vault.read(vault.file(path)!), path).toBe(raw);
    }
    expect(await vault.read(vault.file(unrelatedDaily)!)).toBe(unrelatedBytes);
    expect(vault.trashed).toEqual([]);
  });
});
