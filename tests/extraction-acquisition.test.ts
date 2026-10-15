// @vitest-environment node
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { TFile } from 'obsidian';
import { createDocument, readDocument } from '../src/core/document';
import { ArticleStore, type VaultPort } from '../src/core/store';
import { Ingestion } from '../src/host/ingestion';
import type { Network } from '../src/host/network';
import { MemoryVault } from './helpers/memory-vault';

// Keep extraction, Defuddle, sanitization and guarded writes real; only host I/O is fake.
const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));
vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));

const url = 'https://news.example/title-only';
// Deliberately exceeds the generic readability thresholds: length alone is not prose.
const title = 'A sufficiently long publisher headline that contains no readable article body';
const message = 'Only the page title was found, not the article. Please retry extraction.';
const html = `<!doctype html><html><head><title>${title}</title></head><body><article><p>${title}</p></article></body></html>`;
const running: { ingestion: Ingestion; store: ArticleStore<TFile> }[] = [];

afterEach(() => {
  running.splice(0).forEach(({ ingestion, store }) => {
    ingestion.stop();
    store.dispose();
  });
  vi.restoreAllMocks();
});

function fixture() {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault as unknown as VaultPort<TFile>);
  const get = vi.fn(async () => ({
    status: 200,
    text: html,
    headers: { 'content-type': 'text/html' },
  }));
  const ingestion = new Ingestion(store, vi.fn(), { get } as unknown as Network);
  running.push({ ingestion, store });
  return { vault, store, get, ingestion };
}

it('persists a visible title-only extraction error without changing an empty capture body', async () => {
  const f = fixture();
  const file = await f.store.capture({ url });
  const before = await f.store.read(file.path);
  expect(before.body.trim()).toBe('');

  await expect(f.ingestion.acquire(file.path, true)).rejects.toThrow(message);

  const saved = readDocument(await f.vault.read(file));
  expect(saved.body).toBe(before.body);
  expect(saved.properties).toEqual({ ...before.properties, error: message });
  expect(f.store.catalog.article(file.path)?.error).toBe(message);
  expect(file.path).toBe(before.path);
  expect(f.get).toHaveBeenCalledExactlyOnceWith(
    url,
    'text/html, application/xhtml+xml',
    expect.any(Function),
  );
});

it('rejects title-only redownload and preserves every byte of a protected existing article', async () => {
  const f = fixture();
  const raw = createDocument(
    {
      type: 'article',
      status: 'later',
      url,
      title: 'My explicit title',
      custom: { keep: true },
      bookmark: 'Authored words',
    },
    'Authored words with an ==important highlight== and [inline link](Other.md).\n\n<!-- Keep this comment. -->',
  );
  const file = await f.vault.create('Reading/Articles/Protected.md', raw);
  f.store.catalog.update(file.path, readDocument(raw).properties);
  const snapshot = await f.store.read(file.path);
  const replace = vi.spyOn(f.store, 'replaceArticle');

  await expect(f.ingestion.redownload(snapshot, new AbortController().signal)).rejects.toThrow(
    message,
  );

  expect(await f.vault.read(file)).toBe(raw);
  expect(file.path).toBe(snapshot.path);
  expect(f.store.catalog.article(file.path)?.error).toBeUndefined();
  expect(replace).not.toHaveBeenCalled();
  expect(f.get).toHaveBeenCalledOnce();
});
