import assert from 'node:assert/strict';
import { assertRuntimeVault } from './cdp.mjs';

export function isControlledURL(value) {
  try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname.startsWith('/reader-runtime/'); }
  catch { return false; }
}
export function unsafeLiveArticles(articles) {
  return articles.filter(article => {
    let url; try { url = new URL(article.url); } catch { return false; }
    return ['http:', 'https:'].includes(url.protocol) && ['pending', 'summary', 'dummy'].includes(article.extractor)
      && article.content !== 'protected' && article.highlights.length === 0 && !isControlledURL(article.url);
  });
}
export async function assertControlledAcquisition(page, live = false) {
  await assertRuntimeVault(page);
  const { articles, feeds } = await page.evaluate(async () => {
    const repository = window.app.plugins.plugins['obsidian-reader'].controller.repository;
    return { articles: await repository.listArticles(), feeds: await repository.listFeeds() };
  });
  const unsafeFeeds = feeds.filter(feed => feed.enabled && !isControlledURL(feed.url));
  assert.deepEqual(unsafeFeeds.map(feed => feed.path), [], 'Refusing QA refresh while non-fixture feeds are enabled; do not disable user feeds silently');
  if (live) assert.deepEqual(unsafeLiveArticles(articles).map(article => article.path), [],
    'Refusing live opt-in: unfinished/dummy non-fixture notes could fetch public URLs or rewrite templates. Coordinate safe fixture isolation first; never mask this with a transport mock.');
  return { scope: 'Only controlled loopback origins may be acquired during QA', checkedArticles: articles.length, checkedFeeds: feeds.length, live };
}
