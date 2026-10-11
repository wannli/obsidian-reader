import { noteMetadata } from './markdown-helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { StaleArticleWriteError } from '../src/storage/preconditions';
import { DEFAULT_SETTINGS, type HttpGet, type HttpResponse } from '../src/types';

afterEach(() => vi.restoreAllMocks());
const firstPath = 'Reading/Inbox/261009 Fetch A.md', queuedPath = 'Reading/Inbox/261009 Fetch B.md';
const firstUrl = 'https://publisher.example/a', queuedUrl = 'https://publisher.example/b', replacementUrl = 'https://publisher.example/replacement';
function pending(url: string, comment: string) {
  return `---\ntype: article\nurl: ${url}\ncustom: keep\n---\n## Article\n\n## Comments\n\n${comment}\n`;
}
const response: HttpResponse = {
  status: 200, headers: { 'content-type': 'text/html' },
  text: '<html><head><title>Fetched source</title></head><body><article><h1>Fetched source</h1><p>' +
    'Verified extracted text. Requests belong to their original article, not a replacement occupying its old filename. '.repeat(12) +
    '</p></article></body></html>',
};
function fixture() {
  const store = new MemoryStore({
    [firstPath]: pending(firstUrl, 'A personal writing.'),
    [queuedPath]: pending(queuedUrl, 'B personal writing.'),
    'Notes/Unrelated.md': 'Unrelated bytes.\n',
  });
  const settings = { ...DEFAULT_SETTINGS, useDummyContent: false }, repo = new ReaderRepository(store, settings);
  let release!: (value: HttpResponse) => void;
  const held = new Promise<HttpResponse>(resolve => { release = resolve; });
  // Real extraction/HTTP boundary: hold A, and let any erroneous replacement fetch finish visibly.
  const get = vi.fn<HttpGet>().mockImplementation(url => url === firstUrl ? held : Promise.resolve(response));
  const controller = new ReaderController(repo, get, settings);
  controller.setOnline(true); // Keep the automatic worker inactive; only these explicit requests run.
  return { store, repo, get, controller, release: () => release(response) };
}

describe('queued acquisition retains its invocation-time path generation', () => {
  it.each(['acquire', 'fetchFullText'] as const)('%s rejects an old-path replacement before reading or fetching it', async method => {
    const { store, repo, get, controller, release } = fixture();
    const reads = vi.spyOn(repo, 'getArticle'), save = vi.spyOn(repo, 'saveContent'), errors = vi.spyOn(repo, 'setArticleError');
    const original = await store.read(queuedPath), generation = repo.articleGeneration(queuedPath);
    try {
      const first = controller.fetchFullText(firstPath);
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      const queued = controller[method](queuedPath);
      const outcome = queued.then(() => undefined, error => error);
      expect(reads.mock.calls.some(([path]) => path === queuedPath)).toBe(false);
      const moved = await controller.move(queuedPath, 'later');
      expect(repo.articleGeneration(queuedPath)).not.toBe(generation);
      expect(moved.path).toBe('Reading/Later/261009 Fetch B.md');
      expect(await store.read(moved.path)).toBe(original);
      const replacement = pending(replacementUrl, 'Replacement personal writing.');
      await store.create(queuedPath, replacement);
      const beforeRelease = store.snapshot();
      expect(get.mock.calls.map(([url]) => url)).toEqual([firstUrl]);
      release();
      expect((await first).body).toContain('Verified extracted text.');
      expect(await outcome).toBeInstanceOf(StaleArticleWriteError);
      // Rejection precedes getArticle, not merely an eventual guarded save or error write.
      expect(reads.mock.calls.some(([path]) => path === queuedPath)).toBe(false);
      expect(get.mock.calls.map(([url]) => url)).toEqual([firstUrl]);
      expect(save.mock.calls.map(([path]) => path)).toEqual([firstPath]);
      expect(errors).not.toHaveBeenCalled();
      expect(await store.read(moved.path)).toBe(original);
      expect(await store.read(queuedPath)).toBe(replacement);
      expect(store.snapshot()).toEqual({ ...beforeRelease, [firstPath]: expect.any(String) });
      expect(await noteMetadata(store, firstPath)).toMatchObject({ type: 'article', url: firstUrl, custom: 'keep' });
      expect(await store.read(firstPath)).not.toMatch(/^\s*(?:id|content|extractor):/m);
      expect(controller.isFetchingFullText(queuedPath)).toBe(false);
    } finally { release(); await controller.shutdown(); }
  });

  it.each(['acquire', 'fetchFullText'] as const)('%s still processes an unchanged queued article after A completes', async method => {
    const { store, repo, get, controller, release } = fixture();
    const generation = repo.articleGeneration(queuedPath);
    try {
      const first = controller.fetchFullText(firstPath);
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      const queued = controller[method](queuedPath);
      expect(get.mock.calls.map(([url]) => url)).toEqual([firstUrl]);
      release();
      await first;
      const saved = await queued;
      expect(saved).toMatchObject({ path: queuedPath, url: queuedUrl });
      expect(saved.body).toContain('Verified extracted text.');
      expect(repo.articleGeneration(queuedPath)).toBe(generation);
      expect(get.mock.calls.map(([url]) => url)).toEqual([firstUrl, queuedUrl]);
      expect(await store.read(queuedPath)).toContain('B personal writing.');
      expect(await store.read('Notes/Unrelated.md')).toBe('Unrelated bytes.\n');
    } finally { release(); await controller.shutdown(); }
  });
});
