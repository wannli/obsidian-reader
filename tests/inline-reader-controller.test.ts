import { expect, it, vi } from 'vitest';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { mountReader } from '../src/ui/reader';
import { parseInlineMarkdown } from '../src/inline/parser';
import { buildCanonicalTextIndex, rangeFromPosition } from '../src/highlights/text-index';
import { DEFAULT_SETTINGS } from '../src/types';
const anchor = { start: 0, end: 4, prefix: '', suffix: '', version: 'inline-revision' };
it.each(['# Test\n\n==one== two three', '==one== two three'])('uses the repository title-scoped revision and IDs for Reader autosave: %s', async source => {
  const path = 'Reading/Inbox/Test.md';
  const store = new MemoryStore({ [path]: '---\ntype: article\ntitle: Test\n---\n' + source }), repository = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repository.getArticle(path);
  const controller = new ReaderController(repository, vi.fn(), DEFAULT_SETTINGS);
  const root = document.createElement('div'); document.body.append(root); vi.useFakeTimers();
  const stop = mountReader(root, article, controller, { openNote: vi.fn() }, () => {});
  try {
    const body = root.querySelector<HTMLElement>('.r2-article-body')!;
    expect(body.querySelector('h1')).toBeNull();
    expect(body.dataset.articleVersion).toBe(article.highlights[0].anchor!.version);
    expect(body.querySelector('mark')!.dataset.inlineHighlightId).toBe(article.highlights[0].id);
    const range = rangeFromPosition(buildCanonicalTextIndex(body), { start: 4, end: 7 });
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      expect((await repository.getArticle(article.path)).body).toBe(source.replace('two', '==two=='));
    });
    const saved = await repository.getArticle(article.path);
    expect(saved.body).toBe(source.replace('two', '==two=='));
    expect(saved.highlights).toHaveLength(2);
    expect(body.dataset.articleVersion).toBe(parseInlineMarkdown(saved.body, { stripTitle: saved.title }).revision);
    expect(document.getSelection()!.getRangeAt(0)).toBe(range);
    document.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
    expect([...body.querySelectorAll<HTMLElement>('mark')].map(mark => mark.dataset.inlineHighlightId)).toEqual(saved.highlights.map(mark => mark.id));
  } finally { stop(); document.getSelection()?.removeAllRanges(); root.remove(); await controller.shutdown(); vi.useRealTimers(); }
});
it('adds highlights through the annotation repository API', async () => {
  const addHighlight = vi.fn(async () => ({ body: '==text==' }));
  const repository = { articleGeneration: () => 0, addHighlight } as unknown as ReaderRepository;
  const controller = new ReaderController(repository, vi.fn(), DEFAULT_SETTINGS);
  await controller.highlight('article.md', 'text', anchor);
  expect(addHighlight).toHaveBeenCalledWith('article.md', { quote: 'text', anchor });
  await controller.shutdown();
});
it('invalidates an annotation waiting for editor eligibility when note identity changes', async () => {
  let generation = 0, release!: () => void;
  const addHighlight = vi.fn();
  const repository = { articleGeneration: () => generation, addHighlight } as unknown as ReaderRepository;
  const controller = new ReaderController(repository, vi.fn(), { ...DEFAULT_SETTINGS }, () => new Promise<void>(resolve => { release = resolve; }));
  const pending = controller.highlight('article.md', 'text', anchor); await Promise.resolve();
  generation++; release(); await expect(pending).rejects.toThrow(); expect(addHighlight).not.toHaveBeenCalled();
  await controller.shutdown();
});
