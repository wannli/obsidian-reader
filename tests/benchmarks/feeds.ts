import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { TFile } from 'obsidian';
import { Ingestion } from '../../src/host/ingestion';
import type { ArticleStore } from '../../src/core/store';
import { readDocument } from '../../src/core/document';
import { measure, difference, type Measurement } from './measure';
import { ARTICLE_COUNT, FEED_COUNT, articleUrl, feedUrl, bodyFor, type Context } from './scale';
import { configure, transportCounts, peakRequests } from './obsidian-stub';

// This entire module is dynamically imported only after JSDOM is installed. Ingestion
// and content conversion are real; the build aliases only obsidian.requestUrl.
export async function runFeeds(context: Context, now: string) {
  const { port, store, feeds, originalFeeds } = context;
  const notices: string[] = [],
    ingestion = new Ingestion(store as unknown as ArticleStore<TFile>, (message) =>
      notices.push(message),
    );
  const urls = new Map(feeds.map((_, id) => [feedUrl(id), id]));
  const xml = new Map<string, string>();
  let mode: 'duplicates' | 'burst' = 'duplicates';
  const generate = (feed: number, sequences: number[]) =>
    `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Scale wire ${feed}</title>${sequences
      .map((sequence) => {
        const published = new Date(Date.parse(now) + (sequence - 100) * 1000).toISOString();
        return `<item><title>Scale feed article ${sequence}</title><link>${articleUrl(feed, sequence)}</link><pubDate>${published}</pubDate><content:encoded><![CDATA[<p>${bodyFor(feed)}</p>]]></content:encoded></item>`;
      })
      .join('')}</channel></rss>`;
  for (let feed = 0; feed < FEED_COUNT; feed++) {
    xml.set(
      `duplicates:${feed}`,
      generate(
        feed,
        Array.from({ length: 25 }, (_, i) => 75 + i),
      ),
    );
    xml.set(
      `burst:${feed}`,
      generate(feed, [
        ...Array.from({ length: 25 }, (_, i) => 100 + i),
        ...Array.from({ length: 20 }, (_, i) => 80 + i),
      ]),
    );
  }
  configure((url) => {
    const feed = urls.get(url);
    assert.notEqual(feed, undefined, `Unexpected external request: ${url}`);
    return xml.get(`${mode}:${feed}`)!;
  });
  const counts = () => ({ ...port.counts(), ...transportCounts() });
  const measurements: Measurement[] = [];
  let enabledMs = 0,
    restoredMs = 0,
    enabledOperations = {},
    restoredOperations = {};
  try {
    // ONLY this hidden, owned corpus is changed by Node. No Obsidian API is called.
    const start = performance.now(),
      before = counts();
    for (const feed of [...store.catalog.feeds()]) await ingestion.setFeed(feed, true);
    enabledMs = performance.now() - start;
    enabledOperations = difference(counts(), before);
    const steady = await measure(
      '100-feed-duplicate-window',
      3,
      counts,
      () => ingestion.refreshAll(),
      () => {
        assert.deepEqual(notices, []);
        assert.equal(store.catalog.size, ARTICLE_COUNT);
      },
    );
    assert.equal(steady.operations.stubRequests, 300);
    assert.equal(steady.operations.creates, 0);
    assert.equal(steady.operations.writes, 0);
    measurements.push(steady);
    mode = 'burst';
    const burst = await measure(
      '100-feed-single-bounded-burst',
      1,
      counts,
      () => ingestion.refreshAll(),
      () => {
        assert.deepEqual(notices, []);
        assert.equal(store.catalog.size, ARTICLE_COUNT + FEED_COUNT * 20);
        for (let feed = 0; feed < FEED_COUNT; feed++) {
          for (let sequence = 100; sequence < 125; sequence++) {
            const article = store.catalog.findUrl(articleUrl(feed, sequence));
            assert.equal(!!article, sequence >= 105, 'Latest20 bound violated');
            if (article) {
              assert.equal(article.status, 'feed');
              assert.equal(article.queue, 'Feed');
              assert(article.path.startsWith('Reading/Articles/'));
            }
          }
        }
      },
    );
    assert.equal(burst.operations.stubRequests, 100);
    assert.equal(burst.operations.creates, 2000);
    measurements.push(burst);
    const duplicateBurst = await measure(
      '100-feed-post-burst-duplicates',
      1,
      counts,
      () => ingestion.refreshAll(),
      () => {
        assert.deepEqual(notices, []);
        assert.equal(store.catalog.size, ARTICLE_COUNT + 2000);
        for (let feed = 0; feed < FEED_COUNT; feed++)
          for (let sequence = 100; sequence < 105; sequence++)
            assert.equal(store.catalog.findUrl(articleUrl(feed, sequence)), undefined);
      },
    );
    assert.equal(duplicateBurst.operations.stubRequests, 100);
    assert.equal(duplicateBurst.operations.creates, 0);
    assert.equal(duplicateBurst.operations.writes, 0);
    measurements.push(duplicateBurst);
  } finally {
    ingestion.stop();
    const start = performance.now(),
      before = counts();
    for (const file of feeds) {
      const original = originalFeeds.get(file)!;
      await port.process(file, () => original);
      store.catalog.update(file.path, readDocument(original).properties);
    }
    restoredMs = performance.now() - start;
    restoredOperations = difference(counts(), before);
  }
  assert(peakRequests() <= 2, 'Native request slots exceeded');
  return {
    status: 'completed',
    addedArticles: 2000,
    initialArticles: ARTICLE_COUNT,
    finalArticles: store.catalog.size,
    simulatedFeedUrls: FEED_COUNT,
    initialListedItemsPerFeed: 25,
    burstListedItemsPerFeed: 45,
    burstNewOfferedPerFeed: 25,
    burstNewSavedPerFeed: 20,
    bodySizeBasisBytes: 10 * 1024,
    maxSimultaneousStubRequests: peakRequests(),
    subscriptionsRestoredDisabled: true,
    setup: { enabledMs, enabledOperations, restoredMs, restoredOperations },
    measurements,
    note: 'Subscriptions temporarily enabled and restored byte-for-byte by Node inside the hidden corpus only; no native Obsidian operations. p95/max for the single burst are the same single sample.',
  };
}
