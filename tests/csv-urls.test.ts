import { describe, expect, it } from 'vitest';
import { csvUrls } from '../src/core/csv-urls';

describe('bulk article URLs', () => {
  it('splits comma, semicolon and newlines, accepting www. links', () => {
    expect(csvUrls('www.google.com,www.bing.com;www.brave.com\r\nhttps://example.com/a')).toEqual([
      'https://www.google.com/',
      'https://www.bing.com/',
      'https://www.brave.com/',
      'https://example.com/a',
    ]);
  });

  it('ignores empty entries and deduplicates normalized URLs', () => {
    expect(
      csvUrls('\uFEFFhttps://example.com/a#section, ;\nwww.google.com;https://example.com/a'),
    ).toEqual(['https://example.com/a', 'https://www.google.com/']);
  });

  it('rejects invalid entries before any article is saved', () => {
    expect(() => csvUrls('https://example.com,invalid')).toThrow(/Invalid article URL: invalid/);
    expect(() => csvUrls('file:///private')).toThrow(/Invalid article URL/);
    expect(() => csvUrls(' ;\n, ')).toThrow(/Enter at least one/);
  });

  it('does not silently interpret a CSV header or title as a URL', () => {
    expect(() => csvUrls('url;title\nhttps://example.com;Example')).toThrow(
      /Invalid article URL: url/,
    );
  });
});
