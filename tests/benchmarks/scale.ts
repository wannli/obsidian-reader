import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Catalog, ReadingQueue } from '../../src/core/catalog';
import { ArticleStore, type NoteFile } from '../../src/core/store';
import { createDocument, readDocument, replaceBody } from '../../src/core/document';
import { addHighlight, locateSelection, passages } from '../../src/core/annotations';
import { filename, queueStatus, type Properties, type Queue } from '../../src/core/model';
import { FileVault, type PathGuard } from './fs-vault';
import { difference, measure, type Measurement } from './measure';

export const ARTICLE_COUNT = 10_000,
  FEED_COUNT = 100,
  BODY_BYTES = 10 * 1024;
const queues: Queue[] = ['Inbox', 'Later', 'Archive', 'Feed'];
export const articleUrl = (feed: number, sequence: number) =>
  `https://source-${String(feed).padStart(3, '0')}.invalid/articles/${sequence}`;
export const feedUrl = (feed: number) =>
  `https://source-${String(feed).padStart(3, '0')}.invalid/feed.xml`;
export const quote = (id: number) =>
  `Scale highlight passage ${String(id).padStart(5, '0')} is intentionally unique.`;
export function bodyFor(id: number): string {
  const lead = `# Saved synthetic article ${id}\n\n${quote(id)}\n\n`;
  const filler =
    'This synthetic paragraph measures local reading work without personal data or external resources.\n\n';
  return (lead + filler.repeat(Math.ceil(BODY_BYTES / filler.length))).slice(0, BODY_BYTES);
}

export async function runCore(options: {
  root: string;
  guard: PathGuard;
  now: string;
  log: (message: string) => void;
}) {
  const port = new FileVault(options.root, options.guard),
    store = new ArticleStore(port);
  const now = new Date(options.now),
    articles: NoteFile[] = [],
    feeds: NoteFile[] = [];
  const expected = new Map<NoteFile, string>(),
    measurements: Measurement[] = [];
  const counts = () => port.counts();
  let start = performance.now(),
    before = counts(),
    cursor = 0,
    completed = 0;
  options.log('Generating 10,000 articles (10 KiB each) and 100 disabled feeds on disk');
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (cursor < ARTICLE_COUNT + FEED_COUNT) {
        const id = cursor++;
        if (id < ARTICLE_COUNT) {
          const feed = id % FEED_COUNT,
            sequence = Math.floor(id / FEED_COUNT);
          const title = `Scale ${String(id).padStart(5, '0')} topic-${String(id % 50).padStart(2, '0')}`;
          const queue = queues[Math.floor(id / (ARTICLE_COUNT / queues.length))];
          const properties = {
            type: 'article',
            status: queueStatus(queue),
            title,
            url: articleUrl(feed, sequence),
            published: options.now,
            feed: `[[Reading/Feeds/Wire ${String(feed).padStart(3, '0')}.md]]`,
          };
          articles[id] = await port.create(
            `Reading/Articles/${filename(title, now, '', true)}`,
            createDocument(properties, bodyFor(id)),
          );
        } else {
          const feed = id - ARTICLE_COUNT;
          feeds[feed] = await port.create(
            `Reading/Feeds/Wire ${String(feed).padStart(3, '0')}.md`,
            createDocument(
              {
                type: 'feed',
                title: `Scale wire ${feed}`,
                url: feedUrl(feed),
                prefix: `Wire ${feed}`,
                enabled: false,
              },
              'Synthetic offline subscription.\n',
            ),
          );
        }
        if (++completed % 2500 === 0) options.log(`Created ${completed} files`);
      }
    }),
  );
  const generation = { ms: performance.now() - start, operations: difference(counts(), before) };
  assert.equal(port.files.size, ARTICLE_COUNT + FEED_COUNT);
  start = performance.now();
  before = counts();
  const metadata: { path: string; properties: Properties }[] = [],
    originalFeeds = new Map<NoteFile, string>();
  let initialBytes = 0;
  for (const file of port.files.values()) {
    const raw = await port.read(file),
      doc = readDocument(raw);
    initialBytes += Buffer.byteLength(raw);
    metadata.push({ path: file.path, properties: doc.properties });
    if (doc.properties.type === 'article') assert.equal(Buffer.byteLength(doc.body), BODY_BYTES);
    else {
      assert.equal(doc.properties.enabled, false);
      originalFeeds.set(file, raw);
    }
  }
  const metadataPreparation = {
    ms: performance.now() - start,
    operations: difference(counts(), before),
  };
  const fill = (catalog: Catalog) => {
    for (const entry of metadata) catalog.update(entry.path, entry.properties);
    return catalog;
  };
  const checkIndex = (catalog: Catalog) => {
    assert.equal(catalog.size, ARTICLE_COUNT);
    assert.equal(catalog.feeds().length, FEED_COUNT);
  };
  const noReads = (measurement: Measurement) => {
    assert.equal(measurement.operations.reads, 0, `${measurement.name} read note bodies`);
    assert.equal(measurement.operations.writes, 0, `${measurement.name} wrote files`);
    measurements.push(measurement);
  };
  noReads(await measure('metadata-index-first', 1, counts, () => fill(store.catalog), checkIndex));
  noReads(
    await measure('metadata-index-rebuild', 10, counts, () => fill(new Catalog()), checkIndex),
  );
  noReads(
    await measure(
      'paged-list-first',
      1,
      counts,
      () => store.catalog.list('Inbox', '', 0, 50),
      (rows) => assert.equal(rows.length, 50),
    ),
  );
  noReads(
    await measure(
      'paged-list-cached',
      200,
      counts,
      (i) => store.catalog.list('Inbox', '', (i % 50) * 50, 50),
      (rows) => assert.equal(rows.length, 50),
    ),
  );
  noReads(
    await measure(
      'title-search',
      100,
      counts,
      () => store.catalog.list('Inbox', 'topic-17', 0, 50),
      (rows) => assert.equal(rows.length, 50),
    ),
  );
  noReads(
    await measure(
      'source-search',
      100,
      counts,
      () => store.catalog.list('Inbox', 'source-017.invalid', 0, 50),
      (rows) => assert.equal(rows.length, 25),
    ),
  );
  noReads(
    await measure(
      'feed-enumeration-disabled',
      100,
      counts,
      () => store.catalog.feeds(),
      (rows) => {
        assert.equal(rows.length, FEED_COUNT);
        assert(rows.every((row) => !row.enabled));
      },
    ),
  );
  measurements.push(
    await measure(
      'saved-article-read',
      100,
      counts,
      (i) => store.read(articles[(i * 97) % ARTICLE_COUNT].path),
      (saved) => assert.equal(Buffer.byteLength(saved.body), BODY_BYTES),
    ),
  );
  const browsing = new ReadingQueue(),
    paths = store.catalog.paths('Inbox');
  noReads(
    await measure('browsing-queue-snapshot', 100, counts, () => browsing.open(paths, paths[0])),
  );
  measurements.push(
    await measure(
      'browsing-navigation-and-read',
      100,
      counts,
      async () => {
        const next = browsing.neighbour(1, (path) => !!store.catalog.article(path));
        assert(next);
        browsing.select(next);
        return store.read(next);
      },
      (saved) => {
        assert.equal(saved.path, browsing.current);
        assert.equal(Buffer.byteLength(saved.body), BODY_BYTES);
      },
    ),
  );
  noReads(
    await measure(
      'fresh-feed-expiry',
      10,
      counts,
      () => store.expire(now),
      (result) => {
        assert.deepEqual(result, { deleted: 0, retained: 0, promoted: 0 });
        assert.equal(store.catalog.paths('Feed').length, 2500);
      },
    ),
  );
  const annotate = async (id: number) => {
    const snapshot = await store.read(articles[id].path),
      range = locateSelection(snapshot.body, quote(id));
    const body = addHighlight(snapshot.body, range.from, range.to);
    return store.annotate(snapshot, (raw) => replaceBody(raw, snapshot.body, body));
  };
  for (const [name, offset] of [
    ['inbox-annotation', 0],
    ['feed-promotion-and-annotation', 7500],
  ] as const) {
    measurements.push(
      await measure(
        name,
        30,
        counts,
        (i) => annotate(offset + i),
        (saved, i) => {
          assert.equal(saved.path, articles[offset + i].path);
          assert(saved.path.startsWith('Reading/Articles/'));
          assert.equal(saved.properties.status, offset === 7500 ? 'later' : 'inbox');
          assert.equal(passages(saved.body)[0]?.text, quote(offset + i));
          assert.equal(Buffer.byteLength(saved.body), BODY_BYTES + 4);
          expected.set(saved.file, saved.raw);
        },
      ),
    );
  }
  measurements.push(
    await measure(
      'status-only-queue-change',
      30,
      counts,
      async (i) => store.move(await store.read(articles[2500 + i].path), 'Archive'),
      (saved, i) => {
        assert.equal(saved.path, articles[2500 + i].path);
        assert.equal(saved.properties.status, 'archive');
        assert.equal(saved.body, bodyFor(2500 + i));
        expected.set(saved.file, saved.raw);
      },
    ),
  );
  measurements.push(
    await measure(
      'bookmark-write',
      30,
      counts,
      (i) => store.position(articles[i].path, `anchor ${i}`),
      (saved, i) => {
        assert.equal(saved.properties.bookmark, `anchor ${i}`);
        expected.set(saved.file, saved.raw);
      },
    ),
  );
  assert.equal(store.catalog.size, ARTICLE_COUNT);
  assert.equal(counts().moves, 0);
  assert.equal(counts().trashes, 0);
  return {
    port,
    store,
    feeds,
    expected,
    originalFeeds,
    result: {
      setup: { generation, metadataPreparation },
      dataset: {
        initialArticles: ARTICLE_COUNT,
        feeds: FEED_COUNT,
        initialMarkdownFiles: ARTICLE_COUNT + FEED_COUNT,
        articleBodyBytes: BODY_BYTES,
        initialArticleBodyBytes: ARTICLE_COUNT * BODY_BYTES,
        initialMarkdownBytes: initialBytes,
        initialQueues: Object.fromEntries(queues.map((queue) => [queue, 2500])),
        freshFeedExpiryCandidates: 2500,
      },
      measurements,
    },
  };
}
export type Context = Awaited<ReturnType<typeof runCore>>;

export async function verifyFinal(context: Context, addedArticles: number) {
  const { port, store, expected, originalFeeds } = context,
    start = performance.now(),
    before = port.counts();
  let articles = 0,
    feeds = 0,
    bytes = 0,
    minimumBodyBytes = Infinity,
    maximumBodyBytes = 0;
  for (const file of port.files.values()) {
    const raw = await port.read(file),
      doc = readDocument(raw);
    bytes += Buffer.byteLength(raw);
    if (expected.has(file))
      assert.equal(raw, expected.get(file), 'Persisted mutation differs from returned snapshot');
    if (doc.properties.type === 'article') {
      articles++;
      const size = Buffer.byteLength(doc.body);
      minimumBodyBytes = Math.min(minimumBodyBytes, size);
      maximumBodyBytes = Math.max(maximumBodyBytes, size);
      assert.equal(store.catalog.article(file.path)?.url, doc.properties.url);
    } else {
      feeds++;
      assert.equal(doc.properties.type, 'feed');
      assert.equal(doc.properties.enabled, false);
      assert.equal(raw, originalFeeds.get(file), 'Subscription bytes were not restored');
    }
  }
  assert.equal(articles, ARTICLE_COUNT + addedArticles);
  assert.equal(feeds, FEED_COUNT);
  assert.equal(store.catalog.size, articles);
  assert.equal(port.files.size, articles + feeds);
  const entries = await readdir(join(port.root, 'Reading'), {
    withFileTypes: true,
    recursive: true,
  });
  assert(!entries.some((entry) => entry.isSymbolicLink()), 'Unexpected corpus symlink');
  assert.equal(entries.filter((entry) => entry.isFile()).length, articles + feeds);
  assert.equal(port.counts().trashes, 0);
  assert(store.catalog.feeds().every((feed) => !feed.enabled));
  return {
    ms: performance.now() - start,
    operations: difference(port.counts(), before),
    finalArticles: articles,
    finalMarkdownFiles: articles + feeds,
    finalMarkdownBytes: bytes,
    finalArticleBodyBytes: { min: minimumBodyBytes, max: maximumBodyBytes },
    finalQueues: Object.fromEntries(
      queues.map((queue) => [queue, store.catalog.paths(queue).length]),
    ),
    feedNotesRestoredByteForByte: feeds,
    assertionsPassed: true,
  };
}
