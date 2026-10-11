import { mark } from './markdown-helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isAcquisitionUrl } from '../src/acquisition-url';
import * as ingestion from '../src/ingest/extract';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS, type HttpGet, type HttpResponse } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
const response: HttpResponse = { status: 200, text: '<rss version="2.0"><channel><title>Test feed</title><item><guid>one</guid><title>First entry</title><link>https://example.com/one</link></item></channel></rss>', headers: { etag: 'v1' } };
function setup(get: HttpGet, useDummyContent = false) {
  const store = new MemoryStore(); const settings = { ...DEFAULT_SETTINGS, useDummyContent };
  const repo = new ReaderRepository(store, settings); return { repo, store, controller: new ReaderController(repo, get, settings) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('ReaderController', () => {
  it('imports metadata once, leaves states/body intact on refresh, conditionally polls', async () => {
    const get = vi.fn<HttpGet>().mockResolvedValue(response); const { repo, controller } = setup(get);
    await controller.subscribeFeed('https://example.com/rss');
    const [article] = await repo.listArticles(); expect(article.status).toBe('feed'); expect(article.body).toBe('');
    const moved = await controller.move(article.path, 'later');
    expect((await repo.listFeeds())[0].enabled).toBe(false);
    await controller.refreshFeeds(); expect(get).toHaveBeenCalledTimes(1);
    await repo.updateFeed((await repo.listFeeds())[0].path, { enabled: true });
    await controller.refreshFeeds();
    expect(await repo.listArticles()).toHaveLength(1); expect((await repo.getArticle(moved.path)).status).toBe('later');
    expect(get.mock.calls[1][1]).toHaveProperty('If-None-Match', 'v1');
    const calls = get.mock.calls.length; await controller.refreshFeeds(false); expect(get).toHaveBeenCalledTimes(calls);
  });
  it('retains captured article on extraction failure and rejects work after shutdown', async () => {
    const { controller, repo } = setup(async () => { throw new Error('Offline'); });
    const stub = await controller.capture('https://example.com/article'); expect(stub.body).toBe('');
    const article = await controller.acquire(stub.path); expect(article.error).toContain('Offline');
    expect(await repo.listArticles()).toHaveLength(1); expect(article.error).toContain('Offline');
    await controller.shutdown(); await expect(controller.capture('https://example.com/two')).rejects.toThrow('closing');
  });
  it('preserves genuine unverified excerpts in dummy and live modes', async () => {
    const extract = vi.spyOn(ingestion, 'extractArticle').mockResolvedValue({ title: 'Real', markdown: 'Real full text.', status: 'ready', extractor: 'defuddle' });
    const get = vi.fn<HttpGet>(); const { controller, repo } = setup(get, true);
    const article = await repo.createArticle({ title: 'Publisher title', url: 'https://example.com/summary', body: 'Short feed summary.', extractor: 'summary' });
    controller.setActive(true); await new Promise(resolve => setTimeout(resolve, 350));
    expect((await repo.getArticle(article.path)).body).toBe(article.body); expect((await repo.getArticle(article.path)).title).toBe(article.title); expect(extract).not.toHaveBeenCalled();
    controller.settings.useDummyContent = false; controller.scheduleAcquisition(); await new Promise(resolve => setTimeout(resolve, 350));
    expect((await repo.getArticle(article.path)).body).toBe('Short feed summary.'); expect(extract).not.toHaveBeenCalled(); await controller.shutdown();
  });
  it('single-flights all statuses with Inbox/Later priority and pauses until active', async () => {
    const extract = vi.spyOn(ingestion, 'extractArticle').mockImplementation(async url => ({ title: url, markdown: 'Complete article.', status: 'ready', extractor: 'defuddle' }));
    const { controller, repo } = setup(vi.fn<HttpGet>());
    for (const status of ['archive', 'feed', 'later', 'inbox'] as const) await repo.createArticle({ title: status, url: 'https://example.com/' + status, status });
    controller.scheduleAcquisition(); await new Promise(resolve => setTimeout(resolve, 180)); expect(extract).not.toHaveBeenCalled();
    controller.setActive(true); controller.scheduleAcquisition(); controller.scheduleAcquisition();
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(4));
    expect(extract.mock.calls.map(call => new URL(call[0]).pathname)).toEqual(['/inbox', '/later', '/feed', '/archive']);
    await new Promise(resolve => setTimeout(resolve, 350)); expect(extract).toHaveBeenCalledTimes(4); await controller.shutdown();
  });
  it('protects manual, highlighted and unverified nonempty content', async () => {
    const extract = vi.spyOn(ingestion, 'extractArticle').mockResolvedValue({ title: 'Real', markdown: 'Real extracted body.', status: 'ready', extractor: 'defuddle' });
    const { controller, repo } = setup(vi.fn<HttpGet>());
    const manual = await repo.createArticle({ title: 'Manual', url: 'https://example.com/manual', body: 'Authored body.', extractor: 'manual' });
    const marked = await repo.createArticle({ title: 'Marked', url: 'https://example.com/marked', body: 'Dummy body.', extractor: 'dummy' });
    await mark(repo, marked.path, { quote: 'Dummy body.' });
    const dummy = await repo.createArticle({ title: 'Dummy', url: 'https://example.com/dummy', body: 'Dummy body.', extractor: 'dummy' });
    controller.setActive(true);
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(extract).not.toHaveBeenCalled(); expect((await repo.getArticle(dummy.path)).body).toBe('Dummy body.'); expect((await repo.getArticle(manual.path)).body).toBe(manual.body); expect((await repo.getArticle(marked.path)).body).toBe('==Dummy body.==');
    await controller.shutdown();
  });
  it('persists failure backoff across controller reload and resumes unfinished work', async () => {
    const extract = vi.spyOn(ingestion, 'extractArticle').mockRejectedValue(new Error('Offline'));
    const { controller, repo } = setup(vi.fn<HttpGet>());
    const article = await repo.createArticle({ title: 'Retry', url: 'https://example.com/retry', body: '' });
    controller.setActive(true); await vi.waitFor(async () => expect((await repo.getArticle(article.path)).error).toContain('Offline'));
    await controller.shutdown(); expect(extract).toHaveBeenCalledTimes(1);
    const resumed = new ReaderController(repo, vi.fn<HttpGet>(), { ...DEFAULT_SETTINGS, useDummyContent: false }); resumed.setActive(true);
    await new Promise(resolve => setTimeout(resolve, 350)); expect(extract).toHaveBeenCalledTimes(1);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 301000); extract.mockResolvedValue({ title: 'Recovered', markdown: 'Full body.', status: 'ready', extractor: 'defuddle' });
    resumed.scheduleAcquisition(); await vi.advanceTimersByTimeAsync(500);
    expect((await repo.getArticle(article.path)).body).toBe('Full body.'); await resumed.shutdown();
  });
  it('acquires ordinary externally created notes without touching Comments or custom YAML', async () => {
    const { controller, repo, store } = setup(vi.fn<HttpGet>(), true);
    const path = 'Reading/Inbox/External capture.md';
    await store.create(path, '---\ntype: article\nstatus: inbox\nurl: https://example.com/external\nproject: Personal\n---\n## Article\n\n## Comments\n\nMy independent writing.\n');
    controller.setActive(true); controller.scheduleAcquisition();
    await vi.waitFor(async () => expect((await repo.getArticle(path)).body).toContain('Dummy article'));
    const note = await store.read(path); expect(note).toContain('project: Personal'); expect(note).toContain('## Comments\n\nMy independent writing.');
    expect((await repo.getArticle(path)).body).not.toContain('My independent writing.'); await controller.shutdown();
  });
  it('coalesces incremental external vault events without a Reader view or an own-write loop', async () => {
    vi.useFakeTimers(); const get = vi.fn<HttpGet>(); const { controller, repo, store } = setup(get, true);
    const scans = vi.spyOn(repo, 'listArticles'); controller.setActive(true); await vi.advanceTimersByTimeAsync(500);
    await store.create('Reading/Inbox/Capture.md', ''); controller.vaultChanged(); await vi.advanceTimersByTimeAsync(100);
    await store.process('Reading/Inbox/Capture.md', () => '---\ntype: article\nstatus: inbox\nurl: https://example.com/incremental\n---\n## Article\n\n## Comments\n\nKeep typing here.\n');
    controller.vaultChanged(); controller.vaultChanged(); await vi.advanceTimersByTimeAsync(800);
    expect((await repo.getArticle('Reading/Inbox/Capture.md')).body).toContain('Dummy article'); expect(await store.read('Reading/Inbox/Capture.md')).toContain('Keep typing here.');
    const settledScans = scans.mock.calls.length; controller.vaultChanged(); controller.vaultChanged(); await vi.advanceTimersByTimeAsync(2000);
    expect(scans.mock.calls.length).toBe(settledScans + 1); expect(get).not.toHaveBeenCalled(); await controller.shutdown();
  });
  it('does not write a stale extraction over Comments edited in flight', async () => {
    let release!: (value: Awaited<ReturnType<typeof ingestion.extractArticle>>) => void;
    const extract = vi.spyOn(ingestion, 'extractArticle').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { controller, repo, store } = setup(vi.fn<HttpGet>());
    const path = 'Reading/Inbox/Writing.md'; await store.create(path, '---\ntype: article\nstatus: inbox\nurl: https://example.com/writing\n---\n## Article\n\n## Comments\n\nBefore typing.\n');
    const pending = controller.acquire(path); await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    await store.process(path, text => text.replace('Before typing.', 'New writing typed during extraction.'));
    release({ title: 'Real', markdown: 'Genuine full text.', status: 'ready', extractor: 'defuddle' });
    await expect(pending).rejects.toThrow('stale acquisition');
    expect(await store.read(path)).toContain('## Comments\n\nNew writing typed during extraction.');
    expect((await repo.getArticle(path)).body.trim()).toBe(''); await controller.shutdown();
  });
  it('deduplicates extraction and drains an accepted write without starting queued work on shutdown', async () => {
    let release!: (value: Awaited<ReturnType<typeof ingestion.extractArticle>>) => void;
    const extract = vi.spyOn(ingestion, 'extractArticle').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { controller, repo } = setup(vi.fn<HttpGet>());
    const one = await repo.createArticle({ title: 'One', url: 'https://example.com/one' });
    const two = await repo.createArticle({ title: 'Two', url: 'https://example.com/two' });
    const first = controller.acquire(one.path); expect(controller.acquire(one.path)).toBe(first);
    const second = controller.acquire(two.path); await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    const closing = controller.shutdown(); release({ title: 'One', markdown: 'Accepted write.', status: 'ready', extractor: 'defuddle' });
    await closing; await Promise.all([first, second]); expect(extract).toHaveBeenCalledTimes(1);
    expect((await repo.getArticle(one.path)).body).toContain('Accepted write.'); expect((await repo.getArticle(two.path)).body).toBe('');
  });
  it('persists offline stubs even in dummy mode, then resumes from Markdown after restart', async () => {
    const get = vi.fn<HttpGet>(); const { controller, repo } = setup(get, true);
    controller.setOnline(false); controller.setActive(true);
    const stub = await controller.capture('https://example.com/offline', 'Saved offline');
    expect(stub.body).toBe('');
    await new Promise(resolve => setTimeout(resolve, 300)); expect((await repo.getArticle(stub.path)).body).toBe(''); await controller.shutdown();
    const resumed = new ReaderController(repo, get, { ...DEFAULT_SETTINGS }); resumed.setOnline(false); resumed.setActive(true);
    await new Promise(resolve => setTimeout(resolve, 200)); expect((await repo.getArticle(stub.path)).body).toBe('');
    resumed.setOnline(true); await vi.waitFor(async () => expect((await repo.getArticle(stub.path)).body).toContain('Dummy article'));
    expect(get).not.toHaveBeenCalled(); await resumed.shutdown();
  });
  it('does not wait for a slow extraction when capturing another URL and keeps repeated captures distinct', async () => {
    let release!: (value: Awaited<ReturnType<typeof ingestion.extractArticle>>) => void;
    const extract = vi.spyOn(ingestion, 'extractArticle').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { controller, repo } = setup(vi.fn<HttpGet>()); controller.setActive(true);
    const first = await controller.capture('https://example.com/slow'); expect(extract).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    const second = await controller.capture('https://example.com/second'); expect(second.body).toBe('');
    const moved = await controller.move(second.path, 'archive');
    const duplicate = await controller.capture('https://example.com/second', 'Do not rename'); expect(duplicate.path).not.toBe(moved.path); expect(duplicate.status).toBe('inbox'); expect(duplicate.title).toBe('Do not rename');
    const closing = controller.shutdown(); release({ title: 'Slow', markdown: 'Done.', status: 'ready', extractor: 'defuddle' }); await closing;
    expect((await repo.getArticle(first.path)).body).toContain('Done.'); expect((await repo.getArticle(moved.path)).body).toBe('');
  });
  it('reconnect expedites network failures but not permanent HTTP failures', async () => {
    const extract = vi.spyOn(ingestion, 'extractArticle').mockImplementation(async url => { throw new Error(url.endsWith('missing') ? 'Article returned HTTP 404.' : 'Network connection unavailable'); });
    const { controller, repo } = setup(vi.fn<HttpGet>());
    const net = await controller.capture('https://example.com/network'); const missing = await controller.capture('https://example.com/missing');
    await controller.acquire(net.path); await controller.acquire(missing.path); expect(extract).toHaveBeenCalledTimes(2);
    extract.mockResolvedValue({ title: 'Recovered', markdown: 'Online now.', status: 'ready', extractor: 'defuddle' });
    controller.setOnline(false); controller.setActive(true); controller.setOnline(true);
    await vi.waitFor(async () => expect((await repo.getArticle(net.path)).body).toBe('Online now.'));
    expect(extract).toHaveBeenCalledTimes(3); expect((await repo.getArticle(missing.path)).error).toContain('404'); await controller.shutdown();
  });
  it('reads an existing snapshot offline without calling the network', async () => {
    const get = vi.fn<HttpGet>(); const { controller, repo } = setup(get);
    const article = await repo.createArticle({ title: 'Saved', url: 'https://example.com/read', body: 'Offline body.' });
    expect((await controller.acquire(article.path)).body).toContain('Offline body.'); expect(get).not.toHaveBeenCalled();
  });
});

describe('explicit selected-article Defuddle', () => {
  it('uses live mode for exactly the chosen URL, keeps dummy ON, and leaves failure bytes unchanged', async () => {
    const extract = vi.spyOn(ingestion, 'extractArticle').mockResolvedValue({ title: 'Live', markdown: 'Real full text.', status: 'ready', extractor: 'defuddle' });
    const { controller, repo, store } = setup(vi.fn<HttpGet>(), true), chosen = await controller.capture('https://example.com/chosen'), other = await controller.capture('https://example.com/other');
    await controller.fetchFullText(chosen.path); expect(controller.settings.useDummyContent).toBe(true); expect(extract).toHaveBeenCalledExactlyOnceWith(chosen.url, controller.get, 'defuddle');
    expect((await repo.getArticle(other.path)).body).toBe(''); const before = await store.read(other.path); extract.mockRejectedValue(new Error('HTTP 503'));
    await expect(controller.fetchFullText(other.path)).rejects.toThrow('503'); expect(await store.read(other.path)).toBe(before); await controller.shutdown();
  });
  it('does zero offline/protected HTTP and deduplicates an explicit live override behind in-flight dummy', async () => {
    let release!: (result: Awaited<ReturnType<typeof ingestion.extractArticle>>) => void;
    const extract = vi.spyOn(ingestion, 'extractArticle').mockImplementationOnce(() => new Promise(resolve => release = resolve)).mockResolvedValue({ title: 'Live', markdown: 'Live result.', status: 'ready', extractor: 'defuddle' });
    const { controller, repo } = setup(vi.fn<HttpGet>(), true), chosen = await controller.capture('https://example.com/chosen');
    controller.setOnline(false); await expect(controller.fetchFullText(chosen.path)).rejects.toThrow('Offline'); expect(extract).not.toHaveBeenCalled(); controller.setOnline(true);
    const protectedNote = await repo.createArticle({ title: 'Protected', url: 'https://example.com/protected', body: 'Authored.', extractor: 'manual' });
    await expect(controller.fetchFullText(protectedNote.path)).rejects.toThrow('Cannot replace'); expect(extract).not.toHaveBeenCalled();
    const background = controller.acquire(chosen.path); await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    const manual = controller.fetchFullText(chosen.path); expect(controller.fetchFullText(chosen.path)).toBe(manual); expect(controller.acquire(chosen.path)).toBe(manual);
    release({ title: 'Dummy', markdown: 'Dummy text.', status: 'ready', extractor: 'dummy' }); await background;
    await expect(manual).rejects.toThrow('Cannot replace');
    expect(extract.mock.calls.map(call => call[2])).toEqual(['dummy']); expect((await repo.getArticle(chosen.path)).body).toBe('Dummy text.'); await controller.shutdown();
  });
  it('preserves concurrent Comments/custom metadata and vetoes a newly highlighted snapshot', async () => {
    let release!: (result: Awaited<ReturnType<typeof ingestion.extractArticle>>) => void;
    const extract = vi.spyOn(ingestion, 'extractArticle').mockImplementation(() => new Promise(resolve => release = resolve));
    const { controller, repo, store } = setup(vi.fn<HttpGet>(), true);
    const path = 'Reader/Articles/Comments.md'; await store.create(path, '---\ntype: article\nstatus: inbox\nurl: https://example.com/comments\ncustom: keep\n---\n\n## Article\n\n## Comments\nMy notes.\n');
    const first = controller.fetchFullText(path); await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1)); await store.process(path, text => text.replace('My notes.', 'Edited notes.'));
    release({ title: 'Live', markdown: 'Real article.', status: 'ready', extractor: 'defuddle' }); await expect(first).rejects.toThrow('stale acquisition');
    expect(await store.read(path)).toContain('Edited notes.'); expect(await store.read(path)).toContain('custom: keep');
    const marked = await repo.createArticle({ title: 'Marked', url: 'https://example.com/marked' });
    const second = controller.fetchFullText(marked.path); const rejection = expect(second).rejects.toThrow(/preserved|stale acquisition/); await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2));
    await store.process(marked.path, text => text + '\nExisting text.\n'); await mark(repo, marked.path, { quote: 'Existing text.' }); release({ title: 'Live', markdown: 'Replacement.', status: 'ready', extractor: 'defuddle' });
    await rejection; expect((await repo.getArticle(marked.path)).body.trim()).toBe('==Existing text.=='); expect((await repo.getArticle(marked.path)).highlights).toHaveLength(1); await controller.shutdown();
  });
});
describe('P0 template/URL safety before acquisition writes', () => {
  it.each([true, false])('leaves delivered templates and invalid URLs byte-identical across startup/reconnect, dummy=%s', async dummy => {
    const get = vi.fn<HttpGet>(), extract = vi.spyOn(ingestion, 'extractArticle'); const { controller, store } = setup(get, dummy);
    const paths: string[] = [];
    for (const name of ['Article.md', 'Article-quick.md']) { const path = 'Templates/' + name; paths.push(path); await store.create(path, readFileSync('integrations/quickadd/' + name, 'utf8')); }
    for (const [index, url] of ['', 'not a URL', 'http://', 'file:///tmp/article', '{{VALUE:url}}', 'https://example.com/{{VALUE:url}}', 'https://example.com/%7B%7BVALUE:url%7D%7D', 'https://<%tp.file.title%>'].entries()) {
      const path = 'Reader/Articles/Invalid-' + index + '.md'; paths.push(path); await store.create(path, '---\ntype: article\nstatus: inbox\nurl: ' + JSON.stringify(url) + '\n---\n## Article\n\n## Comments\nKeep exactly.\n');
    }
    const before = store.snapshot(); controller.setActive(true); await new Promise(resolve => setTimeout(resolve, 220)); controller.setOnline(false); controller.setActive(false); controller.setOnline(true); controller.setActive(true); await new Promise(resolve => setTimeout(resolve, 220));
    for (const path of paths) { await controller.acquire(path, true).catch(() => {}); await expect(controller.fetchFullText(path)).rejects.toThrow(); }
    await controller.shutdown(); expect(store.snapshot()).toEqual(before); expect(get).not.toHaveBeenCalled(); expect(extract).not.toHaveBeenCalled();
  });
  it('keeps expanded template content and Comments discussion of template tokens untouched', async () => {
    const get = vi.fn<HttpGet>(), { controller, store, repo } = setup(get, true), path = 'Reading/Inbox/Expanded.md';
    const template = readFileSync('integrations/quickadd/Article-quick.md', 'utf8');
    await store.create(path, template.replace('{{VALUE:url|label:Article URL}}', 'https://example.com/expanded') + '## Comments\nThis Comments section discusses {{VALUE:url}} and <% templating %>.\n');
    const before = await store.read(path); const article = await controller.acquire(path); expect(article.body).toContain('This Comments section discusses {{VALUE:url}}'); expect(article.title).toBe('Expanded'); expect(await store.read(path)).toBe(before); expect(await store.read(path)).toContain('This Comments section discusses {{VALUE:url}}'); expect(get).not.toHaveBeenCalled();
    expect(isAcquisitionUrl((await repo.getArticle(path)).url)).toBe(true); await controller.shutdown();
  });
  it('does not stamp late extraction errors after the source URL becomes a placeholder', async () => {
    let fail!: (error: Error) => void; vi.spyOn(ingestion, 'extractArticle').mockImplementation(() => new Promise((_resolve, reject) => fail = reject));
    const { controller, store } = setup(vi.fn<HttpGet>()), article = await controller.capture('https://example.com/late-invalid'); const pending = controller.acquire(article.path);
    await vi.waitFor(() => expect(fail).toBeTypeOf('function')); await store.process(article.path, text => text.replace('https://example.com/late-invalid', '"{{VALUE:url}}"')); const before = await store.read(article.path);
    fail(new Error('HTTP 503')); await pending.catch(() => {}); expect(await store.read(article.path)).toBe(before); await controller.shutdown();
  });
});
