import { afterEach, expect, it, vi } from 'vitest';
import { extract } from '../src/content/extract';
import { createDocument, patchProperties, readDocument } from '../src/core/document';
import { ArticleStore } from '../src/core/store';
import { Ingestion } from '../src/host/ingestion';
import type { Network } from '../src/host/network';
import { MemoryVault, gate } from './helpers/memory-vault';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));
vi.mock('../src/content/extract', () => ({ extract: vi.fn() }));
const extraction = vi.mocked(extract);
const running: Ingestion[] = [];
afterEach(() => {
  running.splice(0).forEach((ingestion) => ingestion.stop());
  vi.restoreAllMocks();
});
async function fixture(properties: Record<string, unknown> = {}) {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const raw = createDocument(
    {
      type: 'article',
      url: 'https://example.com/article',
      title: '',
      custom: 'Keep',
      bookmark: 'My words',
      ...properties,
    },
    'Authored ==highlight== and [inline link](Other.md).',
  );
  const file = await vault.create('Reading/Stream/Article.md', raw);
  store.catalog.update(file.path, readDocument(raw).properties);
  const get = vi.fn().mockResolvedValue({ text: 'Downloaded', status: 200, headers: {} });
  const ingestion = new Ingestion(store as any, vi.fn(), { get } as unknown as Network);
  running.push(ingestion);
  extraction.mockReset().mockImplementation(async (url, fetch) => {
    const response = await fetch(url, 'text/html');
    return { markdown: response.text, title: 'Publisher' };
  });
  return {
    vault,
    store,
    file,
    raw,
    get,
    ingestion,
    snapshot: await store.read(file.path),
    signal: new AbortController(),
  };
}

it('only explicit replacement overwrites protected text, preserves YAML and never moves/renames', async () => {
  const f = await fixture();
  await f.ingestion.acquire(f.file.path, true);
  expect(extraction).not.toHaveBeenCalled();
  await f.ingestion.redownload(f.snapshot as any, f.signal.signal);
  const saved = readDocument(await f.vault.read(f.file));
  expect(saved.body.trim()).toBe('Downloaded');
  expect(saved.properties).toEqual(f.snapshot.properties);
  expect(f.file.path).toBe('Reading/Stream/Article.md');
});

it('preserves legacy reading_position as inert unknown data alongside the current bookmark', async () => {
  const legacy = { old: ['literal [[Notes/Old.md]]'] };
  const f = await fixture({ reading_position: legacy, status: 'later' });
  await f.ingestion.redownload(f.snapshot as any, f.signal.signal);
  const saved = readDocument(await f.vault.read(f.file));
  expect(saved.properties.reading_position).toEqual(legacy);
  expect(saved.properties.bookmark).toBe('My words');
  expect(saved.properties.status).toBe('later');
  expect(saved.body.trim()).toBe('Downloaded');
});

it.each([
  {},
  { status: 'inbox' },
  { status: 'feed' },
  { status: 'later' },
  { status: 'archive' },
  { status: null },
])('confirmed replacement preserves status without implicit promotion: %j', async (properties) => {
  const f = await fixture(properties);
  await f.ingestion.redownload(f.snapshot as any, f.signal.signal);
  const saved = readDocument(await f.vault.read(f.file));
  expect(saved.properties).toEqual(f.snapshot.properties);
  expect(saved.properties.bookmark).toBe('My words');
  expect(f.file.path).toBe(f.snapshot.path);
});

it.each(['network', 'extraction', 'empty extraction'])(
  'preserves every original byte on %s failure',
  async (failure) => {
    const f = await fixture();
    if (failure === 'network') f.get.mockRejectedValue(new Error('Offline'));
    else if (failure === 'extraction')
      extraction.mockRejectedValue(new Error('Node limit exceeded'));
    else extraction.mockResolvedValue({ markdown: '', title: 'Publisher' });
    await expect(f.ingestion.redownload(f.snapshot as any, f.signal.signal)).rejects.toThrow();
    expect(await f.vault.read(f.file)).toBe(f.raw);
  },
);

it.each(['body', 'position', 'status', 'identity', 'rename', 'dirty', 'generation', 'cancel'])(
  'rejects %s changes during download without stale errors or body loss',
  async (change) => {
    const f = await fixture(),
      entered = gate(),
      pending = gate();
    extraction.mockImplementation(async () => {
      entered.resolve();
      await pending.promise;
      return { markdown: 'Downloaded', title: 'Publisher' };
    });
    const result = f.ingestion
      .redownload(f.snapshot as any, f.signal.signal)
      .catch((error) => error);
    await entered.promise;
    if (change === 'body') await f.vault.process(f.file, (raw) => raw + '\nNew words');
    if (change === 'position')
      await f.vault.process(f.file, (raw) => patchProperties(raw, { bookmark: 'Moved' }));
    if (change === 'status')
      await f.vault.process(f.file, (raw) => patchProperties(raw, { status: 'archive' }));
    if (change === 'identity') {
      f.vault.files.delete(f.file.path);
      await f.vault.create(f.file.path, f.raw);
    }
    if (change === 'rename') await f.vault.move(f.file, 'Reading/Inbox/Moved.md');
    if (change === 'dirty') f.vault.dirty.add(f.file);
    if (change === 'generation') f.ingestion.stop();
    if (change === 'cancel') f.signal.abort();
    const current = await f.vault.read(f.vault.file(f.file.path)!);
    pending.resolve();
    expect(await result).toBeInstanceOf(Error);
    expect(await f.vault.read(f.vault.file(f.file.path)!)).toBe(current);
  },
);

it('rejects a changed confirmation snapshot before making any request', async () => {
  const f = await fixture();
  await f.vault.process(f.file, (raw) =>
    patchProperties(raw, { bookmark: 'Changed during confirmation' }),
  );
  await expect(f.ingestion.redownload(f.snapshot as any, f.signal.signal)).rejects.toThrow();
  expect(extraction).not.toHaveBeenCalled();
});

it('never coalesces conservative and confirmed jobs, or separate confirmations', async () => {
  const f = await fixture(),
    entered = gate(),
    pending = gate();
  extraction.mockImplementation(async () => {
    entered.resolve();
    await pending.promise;
    return { markdown: 'Downloaded', title: '' };
  });
  const forced = f.ingestion.redownload(f.snapshot as any, f.signal.signal);
  await entered.promise;
  const conservative = f.ingestion.acquire(f.file.path, true);
  expect(conservative).not.toBe(forced);
  await conservative;
  const other = f.ingestion.redownload(f.snapshot as any, f.signal.signal).catch((error) => error);
  pending.resolve();
  await forced;
  expect(await other).toBeInstanceOf(Error);
  expect(extraction).toHaveBeenCalledTimes(2);
});

it('checks cancellation inside the final native process callback', async () => {
  const f = await fixture(),
    process = f.vault.process.bind(f.vault);
  vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
    f.signal.abort();
    return process(file, update);
  });
  await expect(f.ingestion.redownload(f.snapshot as any, f.signal.signal)).rejects.toThrow();
  expect(await f.vault.read(f.file)).toBe(f.raw);
});
