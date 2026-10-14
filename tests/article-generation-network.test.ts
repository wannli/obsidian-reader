import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TFile } from 'obsidian';
import { ArticleStore } from '../src/core/store';
import { MemoryVault, gate } from './helpers/memory-vault';

const external = vi.hoisted(() => ({ request: vi.fn(), delivered: [] as string[] }));
vi.mock('obsidian', () => ({ requestUrl: external.request }));
vi.mock('../src/content/feed', () => ({ parseFeed: vi.fn(), feedMarkdown: vi.fn() }));
vi.mock('../src/content/extract', () => ({
  extract: async (url: string, get: (url: string, accept: string) => Promise<unknown>) => {
    await get(url, 'text/html, application/xhtml+xml');
    external.delivered.push(url); // The real extractor starts parsing only after this await.
    return { title: 'Acquired', markdown: 'Acquired article body.' };
  },
}));
import { Ingestion } from '../src/host/ingestion';
import { Network } from '../src/host/network';

const target = 'https://example.com/article',
  response = { text: 'HTML', status: 200, headers: {} };
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  external.request.mockReset();
  external.delivered = [];
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function holdSlots() {
  const network = new Network(),
    releases = [gate(), gate()],
    started = [gate(), gate()];
  let active = 0,
    peak = 0;
  external.request.mockImplementation(async ({ url }: { url: string }) => {
    active++;
    peak = Math.max(peak, active);
    try {
      const index = ['https://example.com/hold-0', 'https://example.com/hold-1'].indexOf(url);
      if (index !== -1) {
        started[index].resolve();
        await releases[index].promise;
      }
      return response;
    } finally {
      active--;
    }
  });
  const holds = releases.map((_, i) =>
    network.get(`https://example.com/hold-${i}`, 'hold').catch(() => {}),
  );
  await Promise.all(started.map((start) => start.promise));
  cleanups.push(async () => {
    releases.forEach((release) => release.resolve());
    await Promise.all(holds);
    network.stop();
  });
  const queued = [gate(), gate()];
  const original = network.get;
  let requests = 0;
  vi.spyOn(network, 'get').mockImplementation((url, accept, guard) => {
    const result = original(url, accept, guard);
    queued[requests++]?.resolve();
    return result;
  });
  return { network, releases, queued, peak: () => peak };
}
async function generation(network: Network, url = target) {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault) as unknown as ArticleStore<TFile>;
  const file = await store.capture({ url, title: 'Existing title' });
  const raw = await vault.read(file);
  const ingestion = new Ingestion(store, vi.fn(), network);
  return {
    vault,
    store,
    file,
    raw,
    ingestion,
    retire: () => {
      ingestion.stop();
      store.dispose();
    },
  };
}

it('never dispatches a queued article request after its ingestion generation retires', async () => {
  const f = await holdSlots(),
    old = await generation(f.network);
  const acquire = old.ingestion.acquire(old.file.path).catch((error) => error);
  await f.queued[0].promise;
  old.retire();
  f.releases[0].resolve();
  expect(await acquire).toBeInstanceOf(Error);
  expect(external.request.mock.calls.map(([request]) => request.url)).toEqual([
    'https://example.com/hold-0',
    'https://example.com/hold-1',
  ]);
  expect(external.delivered).toEqual([]);
  expect(await old.vault.read(old.file)).toBe(old.raw);
  expect(f.peak()).toBe(2);
});

it.each(['joined', 'different'] as const)(
  'allows a valid %s new-generation consumer without reviving retired extraction',
  async (kind) => {
    const f = await holdSlots(),
      old = await generation(f.network);
    const retired = old.ingestion.acquire(old.file.path).catch((error) => error);
    await f.queued[0].promise;
    old.retire();
    const nextUrl = kind === 'joined' ? target : 'https://example.com/new';
    const next = await generation(f.network, nextUrl);
    const current = next.ingestion.acquire(next.file.path);
    await f.queued[1].promise;
    expect(external.request).toHaveBeenCalledTimes(2);
    f.releases[0].resolve();
    expect(await retired).toBeInstanceOf(Error);
    await current;
    expect(external.request.mock.calls.map(([request]) => request.url)).toEqual([
      'https://example.com/hold-0',
      'https://example.com/hold-1',
      nextUrl,
    ]);
    expect(external.delivered).toEqual([nextUrl]);
    expect(await old.vault.read(old.file)).toBe(old.raw);
    expect(await next.vault.read(next.file)).toContain('Acquired article body.');
    expect(f.peak()).toBe(2);
    next.retire();
  },
);

it('rejects delivery before extraction when a dispatched article response arrives after retirement', async () => {
  const network = new Network(),
    started = gate(),
    release = gate();
  external.request.mockImplementation(async () => {
    started.resolve();
    await release.promise;
    return response;
  });
  const old = await generation(network);
  const acquire = old.ingestion.acquire(old.file.path).catch((error) => error);
  cleanups.push(async () => {
    release.resolve();
    await acquire;
    network.stop();
  });
  await started.promise;
  old.retire();
  release.resolve();
  expect(await acquire).toBeInstanceOf(Error);
  expect(external.request).toHaveBeenCalledOnce();
  expect(external.delivered).toEqual([]);
  expect(await old.vault.read(old.file)).toBe(old.raw);
});
