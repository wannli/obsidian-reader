import { describe, expect, it } from 'vitest';
import { csvUrls } from '../src/core/csv-urls';

describe('CSV article URLs', () => {
  it('splits both comma and semicolon, including CRLF and blank lines', () => {
    expect(
      csvUrls('\uFEFFhttps://a.example/one; https://a.example/two,\r\n\nhttps://a.example/three'),
    ).toEqual(['https://a.example/one', 'https://a.example/two', 'https://a.example/three']);
  });

  it('uses the URL header instead of interpreting other columns as URLs', () => {
    expect(
      csvUrls(
        'title;URL;notes\r\n"A; title";"https://example.com/a";"hello, world"\r\nB;https://example.com/b;note',
      ),
    ).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('deduplicates canonical URLs without rewriting the existing article', () => {
    expect(csvUrls('url\nhttps://example.com/a#section\nhttps://example.com/a')).toEqual([
      'https://example.com/a',
    ]);
  });

  it('rejects malformed CSV and invalid URLs before importing', () => {
    expect(() => csvUrls('url\n"https://example.com')).toThrow(/unclosed/);
    expect(() => csvUrls('url\n"https://example.com"extra')).toThrow(/after a quoted/);
    expect(() => csvUrls('url;title\nfile:///private;bad')).toThrow(/Invalid article URL/);
    expect(() => csvUrls('url;title\n;empty')).toThrow(/No article URLs/);
  });
});
