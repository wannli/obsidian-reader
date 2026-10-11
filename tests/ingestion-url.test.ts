import { describe, expect, it } from 'vitest';
import { normalizeUrl, resolveWebUrl } from '../src/ingest/url';

describe('ingestion URL policy', () => {
  it('canonicalizes identities conservatively without merging meaningful query/path variants', () => {
    expect(normalizeUrl(' HTTPS://Example.COM:443/a/../Post?q=2&q=1#heading ')).toBe('https://example.com/Post?q=2&q=1');
    expect(normalizeUrl('http://EXAMPLE.com:80')).toBe('http://example.com/');
    expect(normalizeUrl('https://例え.テスト/記事')).toBe(new URL('https://例え.テスト/記事').href);
    expect(normalizeUrl('https://example.com/a/')).not.toBe(normalizeUrl('https://example.com/a'));
    expect(normalizeUrl('https://example.com/?b=2&a=1')).not.toBe(normalizeUrl('https://example.com/?a=1&b=2'));
  });
  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/a', 'ftp://example.com', '//example.com', '/article',
    'https:example.com', '', 'http://', 'https://user:pass@example.com', 'https://user@example.com',
    'https://@example.com', 'https://example.com/\nx', 'https://example.com/\u0000x', 'https://example.com/' + 'a'.repeat(8192)])('rejects unsafe source %s', value => {
    expect(() => normalizeUrl(value)).toThrow();
  });
  it('resolves resource URLs and preserves fragments, but never allows unsafe schemes/credentials', () => {
    expect(resolveWebUrl('../guide#section', 'https://example.com/blog/post')).toBe('https://example.com/guide#section');
    expect(resolveWebUrl('//cdn.example.com/img.png', 'https://example.com/')).toBe('https://cdn.example.com/img.png');
    for (const value of ['javascript:alert(1)', 'data:image/svg+xml,x', '//user:pass@example.com/a', '//@example.com/a']) {
      expect(() => resolveWebUrl(value, 'https://example.com')).toThrow();
    }
  });
});
