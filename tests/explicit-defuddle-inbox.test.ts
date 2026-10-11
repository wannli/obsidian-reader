import { mark } from './markdown-helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReaderController } from '../src/controller';
import * as ingestion from '../src/ingest/extract';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS, type ArticleStatus, type HttpGet } from '../src/types';

const live = { title: 'Live', markdown: 'Usable fetched article.', status: 'ready' as const, extractor: 'defuddle' as const };
async function setup(status: ArticleStatus = 'feed', extractor: 'summary' | 'defuddle' | 'manual' = 'summary') {
  const store = new MemoryStore(), settings = { ...DEFAULT_SETTINGS, useDummyContent: true };
  const repo = new ReaderRepository(store, settings), controller = new ReaderController(repo, vi.fn<HttpGet>(), settings);
  const article = await repo.createArticle({ title: 'Selected', url: 'https://example.com/selected', status, extractor, body: extractor === 'manual' || extractor === 'defuddle' ? 'Existing excerpt.' : '' });
  return { store, repo, controller, article };
}
afterEach(() => vi.restoreAllMocks());
describe('explicit Defuddle Stream promotion', () => {
  it.each(['ready', 'partial'] as const)('moves only after usable %s text is saved and returns the Inbox path', async status => {
    const extract = vi.spyOn(ingestion, 'extractArticle').mockResolvedValue({ ...live, status });
    const { store, repo, controller, article } = await setup();
    const move = vi.spyOn(repo, 'setStatus');
    const save = repo.saveContent.bind(repo);
    vi.spyOn(repo, 'saveContent').mockImplementation(async (...args) => {
      expect(move).not.toHaveBeenCalled();
      expect((await repo.getArticle(article.path)).status).toBe('feed');
      const saved = await save(...args);
      expect(saved.body).toBe(live.markdown); expect(move).not.toHaveBeenCalled(); return saved;
    });
    const saved = await controller.fetchFullText(article.path);
    expect(saved.status).toBe('inbox'); expect(saved.path).toMatch(/^Reading\/Inbox\//);
    expect(saved.path).not.toBe(article.path); expect(await store.exists(article.path)).toBe(false);
    expect((await repo.getArticle(saved.path)).body).toBe(live.markdown);
    expect(move).toHaveBeenCalledExactlyOnceWith(article.path, 'inbox');
    expect(extract).toHaveBeenCalledExactlyOnceWith(article.url, controller.get, 'defuddle');
    expect(controller.settings.useDummyContent).toBe(true); await controller.shutdown();
  });
  it.each(['inbox', 'later', 'archive'] as const)('does not reroute a successful %s fetch', async status => {
    vi.spyOn(ingestion, 'extractArticle').mockResolvedValue(live);
    const { repo, controller, article } = await setup(status), move = vi.spyOn(repo, 'setStatus');
    const saved = await controller.fetchFullText(article.path);
    expect(saved.path).toBe(article.path); expect(saved.status).toBe(status); expect(move).not.toHaveBeenCalled(); await controller.shutdown();
  });
  it.each(['offline', 'network', 'empty', 'save-error', 'protected', 'no-op'] as const)('keeps Stream unchanged on %s', async failure => {
    const extract = vi.spyOn(ingestion, 'extractArticle').mockResolvedValue(live);
    const { store, repo, controller, article } = await setup('feed', failure === 'protected' ? 'manual' : failure === 'no-op' ? 'defuddle' : 'summary');
    const before = await store.read(article.path), move = vi.spyOn(repo, 'setStatus');
    if (failure === 'offline') controller.setOnline(false);
    if (failure === 'network') extract.mockRejectedValue(new Error('Network failed'));
    if (failure === 'empty') extract.mockResolvedValue({ ...live, markdown: '  ' });
    if (failure === 'save-error') vi.spyOn(repo, 'saveContent').mockRejectedValue(new Error('Save failed'));
    await expect(controller.fetchFullText(article.path)).rejects.toThrow();
    expect(move).not.toHaveBeenCalled(); expect(await store.read(article.path)).toBe(before);
    expect((await repo.getArticle(article.path)).status).toBe('feed'); expect(controller.settings.useDummyContent).toBe(true);
    if (['offline', 'protected', 'no-op'].includes(failure)) expect(extract).not.toHaveBeenCalled();
    await controller.shutdown();
  });
  it.each(['authored', 'highlighted'] as const)('keeps Stream when text becomes %s during extraction', async change => {
    let release!: (result: typeof live) => void;
    const extract = vi.spyOn(ingestion, 'extractArticle').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { store, repo, controller, article } = await setup(), move = vi.spyOn(repo, 'setStatus');
    const pending = controller.fetchFullText(article.path), rejected = expect(pending).rejects.toThrow(/preserved|stale acquisition/);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    if (change === 'authored') await store.process(article.path, text => text + '\nMy authored replacement.\n');
    else { await store.process(article.path, text => text + '\nExisting excerpt.\n'); await mark(repo, article.path, { quote: 'Existing excerpt.' }); }
    release(live); await rejected;
    const saved = await repo.getArticle(article.path);
    expect(saved.status).toBe('feed'); expect(saved.body.trim()).toBe(change === 'authored' ? 'My authored replacement.' : '==Existing excerpt.==');
    expect(move).not.toHaveBeenCalled(); await controller.shutdown();
  });
  it('does not promote Stream during automatic live acquisition', async () => {
    vi.spyOn(ingestion, 'extractArticle').mockResolvedValue(live);
    const { repo, controller, article } = await setup(); controller.settings.useDummyContent = false;
    const move = vi.spyOn(repo, 'setStatus'), saved = await controller.acquire(article.path);
    expect(saved.status).toBe('feed'); expect(saved.body).toBe(live.markdown); expect(move).not.toHaveBeenCalled(); await controller.shutdown();
  });
});
