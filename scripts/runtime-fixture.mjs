import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sha256 } from './artifacts.mjs';

// A real loopback origin, not a mocked renderer route or replacement HttpGet.
// Obsidian's production requestUrl fetches both RSS and HTML from this server.
export async function startRuntimeFixture({ articleDelayMs = 0, gateArticle = false, articleStatus = 200, relatedURL } = {}) {
  if (!Number.isInteger(articleDelayMs) || articleDelayMs < 0 || articleDelayMs > 5000) throw new Error('Invalid controlled fixture delay');
  const pendingResponses = new Set(), gatedResponses = new Set();
  let gateOpen = !gateArticle;
  if (relatedURL && new URL(relatedURL).hostname !== '127.0.0.1') throw new Error('Fixture links must stay on controlled loopback origins');
  const tag = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const prefix = `/reader-runtime/${tag}`;
  const articlePath = `${prefix}/article-${tag}`;
  const title = `Reader full-text journey ${tag}`;
  const feedTitle = `Reader loopback feed ${tag}`;
  const quote = `Patient reading leaves a durable trail of understanding for ${tag}.`;
  const feedExcerpt = 'This teaser deliberately omits the full-text highlight passage.';
  const requests = [];
  let base, rss, html, stoppedAt;
  const server = createServer((request, response) => {
    const record = { at: new Date().toISOString(), method: request.method, path: request.url, remoteAddress: request.socket.remoteAddress,
      accept: request.headers.accept, userAgent: request.headers['user-agent'], ifNoneMatch: request.headers['if-none-match'] };
    requests.push(record);
    const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('Connection', 'close');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') { record.status = 405; response.writeHead(405).end(); return; }
    if (requestPath === `${prefix}/feed.xml`) {
      const etag = `"reader-${tag}"`;
      response.setHeader('ETag', etag);
      if (request.headers['if-none-match'] === etag) { record.status = 304; response.writeHead(304).end(); return; }
      record.status = 200;
      response.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' }).end(rss);
    } else if (requestPath === articlePath) {
      const respond = () => {
        record.status = articleStatus; record.responseAt = new Date().toISOString();
        response.writeHead(articleStatus, { 'Content-Type': 'text/html; charset=utf-8' }).end(articleStatus === 200 ? html : 'Controlled fixture transport failure');
      };
      const schedule = () => {
        if (articleDelayMs) {
          const timer = setTimeout(() => { pendingResponses.delete(timer); respond(); }, articleDelayMs);
          pendingResponses.add(timer);
        } else respond();
      };
      if (gateOpen) schedule(); else gatedResponses.add(schedule);
    } else { record.status = 404; response.writeHead(404).end('Not a Reader fixture route'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const articleURL = `${base}${articlePath}`, feedURL = `${base}${prefix}/feed.xml`;
  rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${feedTitle}</title><link>${base}${prefix}/</link><description>A controlled synthetic feed</description>
<item><title>${title}</title><link>${articleURL}</link><guid isPermaLink="false">reader-${tag}</guid><description>${feedExcerpt}</description></item>
</channel></rss>`;
  html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta property="og:title" content="${title}"></head><body>
<main><article><h1>${title}</h1><p>${quote}</p>
<p>A good reading practice begins with an ordinary page and the patience to consider its words. This article is served only by a temporary loopback fixture. Its complete paragraphs are intentionally absent from the RSS teaser, so finding them in the vault proves that the production article request and browser-compatible extraction actually ran.</p>
<h2>A snapshot that belongs to the reader</h2><p>When a passage matters, the useful record is a plain Markdown quotation with a native block reference. The source text should remain stable while the reading list changes. The same words should be present after the source server has stopped, after the plugin has reloaded, and after the application renderer has reopened the note.</p>
<p>Links connect ideas without changing the selected words. A reading note can mark a passage inline or link it to a nearby note while preserving surrounding text. Removing this synthetic highlight or unlinking it should remove only the Markdown delimiters, leave all words intact, and never change an existing journal.</p>
<p>This final paragraph provides enough continuous prose for a meaningful full-text extraction. There are no remote images, no required login, and no external services involved in this fixture. The verification measures desktop behavior in a real Obsidian runtime, not a claim about physical mobile hardware or synchronization.</p>
${relatedURL ? `<p>The reading journey continues in <a href="${relatedURL.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">A related article</a>, another controlled synthetic page that can be saved without leaving this article.</p>` : ''}
</article></main><script>globalThis.__readerFixtureScriptExecuted = true;</script></body></html>`;
  const evidence = () => ({ tag, feedURL, articleURL, title, feedTitle, quote, feedExcerpt, summaryField: 'RSS item description', transport: 'unmodified production Obsidian requestUrl',
    feedSha256: sha256(rss), htmlSha256: sha256(html), articleDelayMs, gateOpen, pendingArticleResponses: gatedResponses.size, stoppedAt, requests: [...requests] });
  async function stop() {
    if (stoppedAt) return;
    stoppedAt = new Date().toISOString();
    for (const timer of pendingResponses) clearTimeout(timer);
    pendingResponses.clear(); gatedResponses.clear();
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  }
  function releaseArticle() { gateOpen = true; for (const respond of gatedResponses) respond(); gatedResponses.clear(); }
  function setArticleStatus(status) { if (![200, 503].includes(status)) throw new Error('Unsupported fixture status'); articleStatus = status; }
  return { tag, title, feedTitle, quote, feedExcerpt, feedURL, articleURL, articlePath, prefix, evidence, stop, releaseArticle, setArticleStatus };
}
