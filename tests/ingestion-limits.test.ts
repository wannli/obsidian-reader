import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpResponse } from '../src/types';
import { INGEST_TIMEOUT_MS, MAX_ARTICLE_BYTES, MAX_DOM_DEPTH, MAX_DOM_NODES, MAX_FEED_BYTES, MAX_FEED_ENTRIES } from '../src/ingest/bounds';
import { extractArticle } from '../src/ingest/extract';
import { parseFeed } from '../src/ingest/feed';

const source = 'https://news.example/article';
const response = (text: string, extra: Partial<HttpResponse> = {}): HttpResponse => ({ status: 200, text, headers: { 'content-type': 'text/html' }, ...extra });
const rss = (items: string) => `<rss><channel><title>Feed</title>${items}</channel></rss>`;

afterEach(() => vi.useRealTimers());

describe('bounded ingestion and visible failures', () => {
  it('rejects unsupported source URLs before calling transport', async () => {
    const get = vi.fn(async () => response(''));
    for (const url of ['javascript:alert(1)', 'file:///tmp/article', 'https://user:pass@example.com/a']) {
      await expect(extractArticle(url, get, 'defuddle')).rejects.toThrow();
    }
    expect(get).not.toHaveBeenCalled();
  });
  it.each<Partial<HttpResponse>>([
    { status: 404 }, { status: 304 }, { status: 500 },
    { headers: { 'content-type': 'application/pdf' } }, { headers: { 'content-type': 'application/json' } },
    { headers: {} }, { url: 'javascript:alert(1)' }, { url: 'https://user:password@example.com/redirect' },
    { headers: { 'content-type': 'text/html', 'content-length': String(MAX_ARTICLE_BYTES + 1) } },
  ])('rejects invalid response metadata', async extra => {
    await expect(extractArticle(source, async () => response('<p>Not usable</p>', extra), 'defuddle')).rejects.toThrow();
  });
  it('propagates network errors and does not invent a ready article', async () => {
    await expect(extractArticle(source, async () => { throw new Error('Offline'); }, 'defuddle')).rejects.toThrow('Offline');
  });
  it('times out a hanging transport and never processes a late response', async () => {
    vi.useFakeTimers();
    let resolve!: (value: HttpResponse) => void;
    const pending = extractArticle(source, () => new Promise<HttpResponse>(done => { resolve = done; }), 'defuddle');
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(INGEST_TIMEOUT_MS);
    await rejected;
    const parser = vi.spyOn(DOMParser.prototype, 'parseFromString');
    resolve(response('<article><p>Late response must never be parsed or written.</p></article>'));
    await Promise.resolve(); await Promise.resolve();
    expect(parser).not.toHaveBeenCalled();
    parser.mockRestore();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears its timeout when transport rejects early', async () => {
    vi.useFakeTimers();
    await expect(extractArticle(source, async () => { throw new Error('Network failed'); }, 'defuddle')).rejects.toThrow('Network failed');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('caps decoded UTF-8 payloads rather than only UTF-16 string length', async () => {
    expect(() => parseFeed(rss('a'.repeat(MAX_FEED_BYTES)), source)).toThrow(/payload limit/);
    expect(() => parseFeed(rss('文'.repeat(Math.ceil(MAX_FEED_BYTES / 3))), source)).toThrow(/payload limit/);
    await expect(extractArticle(source, async () => response('a'.repeat(MAX_ARTICLE_BYTES + 1)), 'defuddle')).rejects.toThrow(/payload limit/);
    await expect(extractArticle(source, async () => response('文'.repeat(Math.ceil(MAX_ARTICLE_BYTES / 3))), 'defuddle')).rejects.toThrow(/payload limit/);
  });
  it('caps feed/article node counts and nesting, including inert template contents', async () => {
    expect(() => parseFeed(rss('<x/>'.repeat(MAX_DOM_NODES)), source)).toThrow(/node limit/);
    expect(() => parseFeed(rss('<x>'.repeat(MAX_DOM_DEPTH) + '</x>'.repeat(MAX_DOM_DEPTH)), source)).toThrow(/depth limit/);
    await expect(extractArticle(source, async () => response('<article>' + '<br>'.repeat(MAX_DOM_NODES) + '</article>'), 'defuddle')).rejects.toThrow(/node limit/);
    await expect(extractArticle(source, async () => response('<div>'.repeat(MAX_DOM_DEPTH + 1) + 'deep' + '</div>'.repeat(MAX_DOM_DEPTH + 1)), 'defuddle')).rejects.toThrow(/depth limit/);
    await expect(extractArticle(source, async () => response('<template>'.repeat(MAX_DOM_DEPTH) + '</template>'.repeat(MAX_DOM_DEPTH)), 'defuddle')).rejects.toThrow(/depth limit/);
  });
  it('rejects excessive entry counts instead of silently truncating a feed', () => {
    const entries = '<item><link>https://news.example/one</link></item>'.repeat(MAX_FEED_ENTRIES + 1);
    expect(() => parseFeed(rss(entries), source)).toThrow(/entry limit/);
  });
});
