import { afterEach, expect, it, vi } from 'vitest';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';
import { StaleArticleWriteError } from '../src/storage/preconditions';
import * as ingestion from '../src/ingest/extract';
afterEach(() => vi.restoreAllMocks());
type Extraction = Awaited<ReturnType<typeof ingestion.extractArticle>>;
function deferred() {
  let resolve!: (value: Extraction) => void, reject!: (error: Error) => void;
  const promise = new Promise<Extraction>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
for (const outcome of ['success', 'failure'] as const) {
  it('early URL cancellation after ' + outcome + ' does not back off the replacement pending URL or persist stale writes', async () => {
    const path = 'Reading/Inbox/Early race.md', original = 'https://example.com/original', replacement = 'https://example.com/replacement';
    const store = new MemoryStore({ [path]: '---\ntype: article\nurl: ' + original + '\n---\n## Article\n\n## Comments\n' });
    const settings = { ...DEFAULT_SETTINGS, useDummyContent: false }, repo = new ReaderRepository(store, settings), controller = new ReaderController(repo, vi.fn<HttpGet>(), settings);
    const first = deferred(), second = deferred(), result: Extraction = { title: 'Stale result', markdown: 'Never persist this text.', status: 'ready', extractor: 'defuddle' };
    const extract = vi.spyOn(ingestion, 'extractArticle').mockImplementationOnce(() => first.promise).mockImplementation(() => second.promise), save = vi.spyOn(repo, 'saveContent'), error = vi.spyOn(repo, 'setArticleError');
    try {
      controller.setActive(true); await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
      await store.process(path, text => text.replace(original, replacement)); const edited = store.snapshot();
      if (outcome === 'success') first.resolve(result); else first.reject(new Error('HTTP 503'));
      // Real worker scheduling, no clock advance or force-retry: replacement must start promptly.
      await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2), { timeout: 1200 });
      expect(extract.mock.calls[1][0]).toBe(replacement); expect(store.snapshot()).toEqual(edited); expect(save).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
      controller.setActive(false); await store.process(path, text => text.replace(replacement, 'https://example.com/third')); const final = store.snapshot();
      second.resolve(result); await controller.shutdown(); expect(store.snapshot()).toEqual(final); expect(save).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { controller.setActive(false); first.resolve(result); second.resolve(result); await controller.shutdown(); }
  });
}
for (const changedUrl of ['not-a-url', 'https://example.com/new-source']) {
  for (const mode of ['automatic success', 'automatic failure', 'manual success'] as const) {
    it('latest process cancels ' + mode + ' after URL changes to ' + changedUrl, async () => {
      const path = 'Reading/Inbox/Race.md', originalUrl = 'https://example.com/original';
      const store = new MemoryStore({ [path]: '---\ntype: article\nurl: ' + originalUrl + '\n---\n## Article\n\n## Comments\n' });
      const settings = { ...DEFAULT_SETTINGS, useDummyContent: false }, repo = new ReaderRepository(store, settings), controller = new ReaderController(repo, vi.fn<HttpGet>(), settings);
      const extract = vi.spyOn(ingestion, 'extractArticle');
      if (mode === 'automatic failure') extract.mockRejectedValue(new Error('HTTP 503')); else extract.mockResolvedValue({ title: 'Old source', markdown: 'Old source content.', status: 'ready', extractor: 'defuddle' });
      let edited = '', armed = true; const process = store.process.bind(store);
      // Real repository/queue: simulate an external edit immediately before its latest process callback.
      vi.spyOn(store, 'process').mockImplementation(async (file, update) => {
        if (file === path && armed) { armed = false; await process(file, text => text.replace(originalUrl, changedUrl)); edited = await store.read(file); }
        return process(file, update);
      });
      const save = vi.spyOn(repo, 'saveContent'), error = vi.spyOn(repo, 'setArticleError');
      const result = mode === 'manual success' ? controller.fetchFullText(path) : controller.acquire(path);
      await expect(result).rejects.toBeInstanceOf(StaleArticleWriteError); await controller.shutdown(); expect(await store.read(path)).toBe(edited); expect(edited).toContain(changedUrl); expect(edited).not.toContain('id:');
      const expectedSource = { expectedUrl: originalUrl, expectedBody: '', expectedRevision: '---\ntype: article\nurl: ' + originalUrl + '\n---\n## Article\n\n## Comments\n', expectedGeneration: 0 };
      if (mode === 'automatic failure') expect(error).toHaveBeenCalledExactlyOnceWith(path, 'HTTP 503', expect.any(String), expect.objectContaining(expectedSource));
      else { expect(error).not.toHaveBeenCalled(); expect(save.mock.calls[0][2]).toMatchObject({ ...expectedSource, ...(mode === 'manual success' ? { allowFeedReplacement: true } : {}) }); }
    });
  }
}
