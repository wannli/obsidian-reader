import Defuddle from 'defuddle/full';
import type { ExtractedArticle, HttpGet, HttpResponse } from '../types';
import { boundText, checkDeadline, INGEST_TIMEOUT_MS, MAX_ARTICLE_BYTES, parseHtml, withDeadline } from './bounds';
import { articleMarkdown } from './markdown';
import { dummyArticle } from './dummy';
import { plainTitle, safeContent, sanitizeBody, visibleText } from './sanitize';
import { normalizeUrl, resolveWebUrl } from './url';

const RESTRICTED = /\b(captcha|verify (?:that )?you are human|subscribe to (?:continue|read)|sign in to (?:continue|read)|enable javascript|access denied|checking your browser|just a moment)\b/i;
const headersOf = (response: HttpResponse): Record<string, string> =>
  Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));

export type ExtractionMode = 'dummy' | 'defuddle';

/** Extraction mode is always selected explicitly by the caller. */
export async function extractArticle(url: string, get: HttpGet, mode: ExtractionMode):
Promise<ExtractedArticle & { extractor: ExtractionMode }> {
  const source = normalizeUrl(url);
  if (mode === 'dummy') return dummyArticle(source);
  if (mode !== 'defuddle') throw new Error('Unknown article extraction mode.');
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  const response = await withDeadline(Promise.resolve().then(() => get(source, { Accept: 'text/html, application/xhtml+xml' })), deadline);
  checkDeadline(deadline);
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) throw new Error(`Article returned HTTP ${response.status}.`);
  const headers = headersOf(response);
  const type = (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!['text/html', 'application/xhtml+xml'].includes(type)) throw new Error('Only HTML articles are supported (HTML Content-Type required).');
  if (Number(headers['content-length']) > MAX_ARTICLE_BYTES) throw new Error('Article exceeds the payload limit.');
  boundText(response.text, MAX_ARTICLE_BYTES, 'Article');
  const finalUrl = response.url ? normalizeUrl(response.url) : source;
  const doc = parseHtml(response.text);
  let base = finalUrl;
  const declaredBase = doc.querySelector('base[href]')?.getAttribute('href');
  if (declaredBase) {
    try { base = resolveWebUrl(declaredBase, finalUrl); } catch { /* Ignore unsafe publisher base URLs. */ }
  }
  const title = plainTitle(doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
    doc.querySelector('title')?.textContent || doc.querySelector('h1')?.textContent, new URL(finalUrl).hostname);
  sanitizeBody(doc, base, true);
  doc.title = title;
  const sourceText = visibleText(doc.body);
  // A conservative fallback: an explicitly designated article/main, never the whole navigation page.
  const fallback = doc.querySelector('article,main')?.innerHTML;
  const warnings: string[] = [];
  let content = safeContent('', base);
  try {
    const result = new Defuddle(doc, {
      url: finalUrl, useAsync: false, markdown: false, removeSmallImages: false,
      // Extraction is deliberately local. Site-specific async/network fallbacks are forbidden.
      fetch: async () => { throw new Error('Extractor network requests are disabled.'); },
    }).parse();
    content = safeContent(result.content, base);
  } catch {
    warnings.push('The primary extractor failed; only a sanitized article fallback may be available.');
  }
  checkDeadline(deadline);
  if (visibleText(content).length < 400 && fallback) {
    const candidate = safeContent(fallback, base);
    if (visibleText(candidate).length > visibleText(content).length) {
      content = candidate;
      warnings.push('Used a simplified article fallback; formatting or content may be incomplete.');
    }
  }
  const text = visibleText(content);
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (text.length < 40 || letters < 20) throw new Error('No usable article text found; the page may be blocked, dynamic or empty.');
  const linkedText = [...content.querySelectorAll('a')].reduce((sum, link) => sum + visibleText(link).length, 0);
  if (linkedText > text.length * 0.7) throw new Error('No usable article found; the page is mostly navigation links.');
  if (text.length < 400 || letters < 150) warnings.push('Extracted text is short and may be incomplete.');
  if (RESTRICTED.test(`${title} ${text.slice(0, 2000)} ${sourceText.slice(0, 2000)}`)) {
    warnings.push('The page may be restricted or require JavaScript; no bypass was attempted.');
  }
  const markdown = articleMarkdown(content, base);
  checkDeadline(deadline);
  if (!markdown) throw new Error('No usable article Markdown found.');
  return { title, markdown, status: warnings.length ? 'partial' : 'ready', extractor: 'defuddle',
    ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
}
