import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isAcquisitionUrl } from '../src/acquisition-url';
import { isArticleNote } from '../src/storage/classifier';
import { parseNote } from '../src/storage/markdown';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { ReaderController } from '../src/controller';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';
const valid = [
  'https://example.com/article?q=100%25&tag=a:b',
  'https://example.com/資料?q=100%25&tag=分類:読書',
  'https://例え.テスト/%E8%B3%87%E6%96%99?q=100%25&tag=a%3Ab',
  'https://example.com/article?q=100%2525&tag=a%253Ab',
];
const placeholders = [
  'https://example.com/article?q=100%25&value={{VALUE:url}}',
  'https://example.com/article?q=100%25&value=%7B%7BVALUE%3Aurl%7D%7D',
  'https://example.com/article?q=100%25&value=%257B%257BVALUE%253Aurl%257D%257D',
  'https://example.com/article?q=100%25&value=%253C%2525tp.file.title%2525%253E',
  'https://example.com/article?q=100%25&value=%2524%257Burl%257D',
  'https://example.com/article?q=100%25&value=%2555%2552%254C%255F%2548%2545%2552%2545',
];
it.each(valid)('accepts valid percent/colon/Unicode URL without changing it: %s', url => {
  const original = url; expect(isAcquisitionUrl(url)).toBe(true); expect(url).toBe(original);
});
it.each([...placeholders, '', 'not a URL', 'http://', 'https://exa mple.com/', 'file:///article', 'javascript:alert(1)', 'https://example.com/%ZZ', 'https://example.com/%E0%A4%A'])('rejects invalid URLs and raw/encoded placeholders: %s', url => {
  expect(isAcquisitionUrl(url)).toBe(false);
});
function rawCapture(url: string) {
  return readFileSync('integrations/quickadd/Article-quick.md', 'utf8').replace('{{VALUE:url|label:Article URL}}', url) + '\n## Comments\n\nUser Comments discuss {{VALUE:url}} and remain untouched.\n';
}
it.each(valid)('classifies and automatically saves raw native QuickAdd Markdown with original URL intact: %s', async url => {
  const path = 'Reading/Inbox/Native percent capture.md', raw = rawCapture(url), settings = { ...DEFAULT_SETTINGS }, store = new MemoryStore({ [path]: raw });
  expect(isArticleNote(path, parseNote(raw).doc.toJS())).toBe(true);
  const repo = new ReaderRepository(store, settings), get = vi.fn<HttpGet>(), controller = new ReaderController(repo, get, settings), save = vi.spyOn(repo, 'saveContent');
  try {
    expect((await repo.listArticles()).map(article => article.path)).toEqual([path]); controller.setActive(true);
    await new Promise(resolve => setTimeout(resolve, 220));
    const saved = await store.read(path); expect(parseNote(saved).doc.get('url')).toBe(url); expect((await repo.getArticle(path)).url).toBe(url); expect(saved).toContain('User Comments discuss {{VALUE:url}} and remain untouched.');
    expect(saved).toBe(raw); expect(save).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  } finally { await controller.shutdown(); }
});
it.each(placeholders)('mixed decoded literal percent plus encoded placeholder remains excluded and byte-identical: %s', async url => {
  const path = 'Reading/Inbox/Unexpanded.md', raw = rawCapture(url), settings = { ...DEFAULT_SETTINGS }, store = new MemoryStore({ [path]: raw });
  expect(isArticleNote(path, parseNote(raw).doc.toJS())).toBe(false);
  const repo = new ReaderRepository(store, settings), get = vi.fn<HttpGet>(), controller = new ReaderController(repo, get, settings);
  try { controller.setActive(true); await new Promise(resolve => setTimeout(resolve, 180)); expect(await repo.listArticles()).toEqual([]); await expect(controller.acquire(path, true)).rejects.toThrow(); expect(await store.read(path)).toBe(raw); expect(get).not.toHaveBeenCalled(); }
  finally { await controller.shutdown(); }
});
