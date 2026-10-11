import { afterEach, describe, expect, it, vi } from 'vitest';
import { marked } from 'marked';
import { extractArticle, type ExtractionMode } from '../src/ingest/extract';
import { DUMMY_NOTICE } from '../src/ingest/dummy';

const engine = vi.hoisted(() => ({ constructor: vi.fn(), parse: vi.fn(), markdown: vi.fn() }));
vi.mock('defuddle/full', () => ({
  default: class {
    constructor() { engine.constructor(); }
    parse() { engine.parse(); throw new Error('Dummy mode must not run Defuddle'); }
  },
  createMarkdownContent: engine.markdown,
}));

const source = 'https://news.example/notes/patient-reading.html';
const noGet = () => vi.fn(async () => { throw new Error('Dummy mode must not fetch articles'); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function expectNoEngine(): void {
  expect(engine.constructor).not.toHaveBeenCalled();
  expect(engine.parse).not.toHaveBeenCalled();
  expect(engine.markdown).not.toHaveBeenCalled();
}

describe('explicit dummy article mode', () => {
  it('returns deterministic labeled generated text with zero transport, DOM or Defuddle invocation', async () => {
    const get = noGet();
    const fetch = vi.fn(async () => { throw new Error('Unexpected network'); });
    vi.stubGlobal('fetch', fetch);
    const parser = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const first = await extractArticle(source + '#one', get, 'dummy');
    const second = await extractArticle('https://NEWS.example:443/notes/patient-reading.html#two', get, 'dummy');
    expect(second).toEqual(first);
    expect(first).toMatchObject({ title: 'Dummy article — news.example: patient reading', status: 'ready', extractor: 'dummy' });
    expect(first.warning).toBeUndefined();
    expect(first).not.toHaveProperty('provenance');
    expect(first.markdown).toContain(DUMMY_NOTICE);
    expect(first.markdown).toContain('It was not downloaded from the linked page');
    expect(first.markdown).toContain('does not represent the publisher’s article');
    expect(first.markdown).toContain(`[Open the original URL](${source})`);
    expect(first.markdown.length).toBeGreaterThan(1800);
    expect(get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(parser).not.toHaveBeenCalled(); expectNoEngine();
  });
  it('provides distinct paragraphs and an ordinary list/link for selection, link and deletion exercises', async () => {
    const result = await extractArticle(source, noGet(), 'dummy');
    const html = marked.parse(result.markdown, { async: false });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('h2')).toHaveLength(3);
    expect(doc.querySelectorAll('p').length).toBeGreaterThanOrEqual(7);
    expect(doc.querySelectorAll('li')).toHaveLength(4);
    expect(doc.querySelector('a')?.getAttribute('href')).toBe(source);
    expect(doc.body.textContent).toContain('A useful highlight preserves an idea without losing its surrounding context.');
    expect(doc.querySelector('script,iframe,img,style,form')).toBeNull();
    expect(result.markdown).not.toContain('<!--');
    expectNoEngine();
  });
  it('does not depend on clock, random IDs, or runtime timers', async () => {
    const get = noGet();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2025-01-01'));
    const before = await extractArticle(source, get, 'dummy');
    vi.setSystemTime(new Date('2035-01-01'));
    expect(await extractArticle(source, get, 'dummy')).toEqual(before);
    expect(vi.getTimerCount()).toBe(0); expect(get).not.toHaveBeenCalled(); expectNoEngine();
  });
  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/story', '/relative',
    'https://user:pass@news.example/story', 'https://@news.example/story', 'https://news.example/\nunsafe',
    'https://news.example/' + 'x'.repeat(8192)])('still rejects unsafe source URLs: %s', async url => {
    const get = noGet();
    await expect(extractArticle(url, get, 'dummy')).rejects.toThrow();
    expect(get).not.toHaveBeenCalled(); expectNoEngine();
  });
  it('escapes hostile URL delimiters without turning generated content into active Markdown', async () => {
    const get = noGet();
    const url = 'https://news.example/%3Cscript%3Ebad%3C%2Fscript%3E?x=)[evil](javascript:alert(1))&y=%22';
    const result = await extractArticle(url, get, 'dummy');
    const doc = new DOMParser().parseFromString(marked.parse(result.markdown, { async: false }), 'text/html');
    expect(result.title).not.toMatch(/[<>\[\]`\n]/);
    expect(doc.querySelectorAll('a')).toHaveLength(1);
    expect(doc.querySelector('a')?.getAttribute('href')).toContain('https://news.example/');
    expect(doc.querySelector('script,img,iframe')).toBeNull();
    expect(get).not.toHaveBeenCalled(); expectNoEngine();
  });
  it('rejects unknown modes rather than accidentally performing a real extraction', async () => {
    const get = noGet();
    await expect(extractArticle(source, get, 'unknown' as ExtractionMode)).rejects.toThrow(/Unknown article extraction mode/);
    expect(get).not.toHaveBeenCalled(); expectNoEngine();
  });
});
