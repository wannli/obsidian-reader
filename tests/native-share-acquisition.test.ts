import { afterEach, expect, it, vi } from 'vitest';
import { extract } from '../src/content/extract';
import { acquireBody, createDocument, readDocument } from '../src/core/document';
import { ArticleStore } from '../src/core/store';
import { Ingestion } from '../src/host/ingestion';
import type { Network } from '../src/host/network';
import { MemoryVault, gate } from './helpers/memory-vault';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));
vi.mock('../src/content/extract', () => ({ extract: vi.fn() }));
const url = 'https://www.apple.com/ios/feature-availability/';
const placeholder = `[iOS and iPadOS 27 - Feature Availability](${url})`;
const sample = `---\ntype: article\nurl: "${url}"\nreading_position: "iOS and iPadOS 27 -"\nbookmark: "Current bookmark"\n---\n${placeholder}\n`;
const extraction = vi.mocked(extract);
const running: Ingestion[] = [];
afterEach(() => {
  running.splice(0).forEach((ingestion) => ingestion.stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(raw = sample) {
  vi.stubGlobal('navigator', { onLine: true });
  const vault = new MemoryVault();
  const store = new ArticleStore(vault);
  const file = await vault.create('Reading/Inbox/Native capture.md', raw);
  store.catalog.update(file.path, readDocument(raw).properties);
  const ingestion = new Ingestion(store as any, vi.fn(), { get: vi.fn() } as unknown as Network);
  running.push(ingestion);
  extraction.mockReset().mockResolvedValue({ markdown: 'Downloaded article.', title: 'Publisher' });
  return { vault, store, file, ingestion, snapshot: await store.read(file.path) };
}

it('acquires the actual native source-link sample, retaining position and its filename', async () => {
  const f = await fixture();
  await f.ingestion.acquire(f.file.path);
  const saved = readDocument(await f.vault.read(f.file));
  expect(saved.body.trim()).toBe('Downloaded article.');
  expect(saved.properties.reading_position).toBe('iOS and iPadOS 27 -');
  expect(saved.properties.bookmark).toBe('Current bookmark');
  expect(saved.properties).not.toHaveProperty('status');
  expect(f.store.catalog.article(f.file.path)?.queue).toBe('Inbox');
  expect(f.store.catalog.article(f.file.path)?.status).toBeUndefined();
  expect(f.file.path).toBe('Reading/Inbox/Native capture.md');
  expect(extraction).toHaveBeenCalledOnce();
});

it.each(['inbox', 'feed', 'later', 'archive', null])(
  'placeholder acquisition preserves explicit status %j and both marker fields',
  async (status) => {
    const f = await fixture(
      createDocument(
        {
          type: 'article',
          url,
          status,
          bookmark: 'Current bookmark',
          reading_position: 'Legacy marker',
        },
        placeholder,
      ),
    );
    await f.ingestion.acquire(f.file.path);
    const saved = readDocument(await f.vault.read(f.file));
    expect(saved.body.trim()).toBe('Downloaded article.');
    expect(saved.properties.status).toBe(status);
    expect(saved.properties.bookmark).toBe('Current bookmark');
    expect(saved.properties.reading_position).toBe('Legacy marker');
    // Acquiring a native share changes its body, not its explicit YAML or folder.
    expect(f.file.path).toBe(f.snapshot.path);
    expect(f.store.catalog.article(f.file.path)?.queue).toBe('Inbox');
  },
);

it.each([
  `[Other](https://example.com/)`,
  `${placeholder} extra text`,
  `Introduction\n\n${placeholder}`,
  `# Title\n${placeholder}`,
  `<!-- comment -->\n${placeholder}`,
  `!${placeholder}`,
  `[==highlight==](${url})`,
  `${placeholder}\n[Other](${url})`,
  `[Authored\nmultiline](${url})`,
  `[Fragment](${url}#section)`,
  url,
])('protects non-placeholder body %s at ingestion and mutation boundaries', async (body) => {
  const raw = createDocument({ type: 'article', url }, body);
  const f = await fixture(raw);
  await f.ingestion.acquire(f.file.path, true);
  expect(extraction).not.toHaveBeenCalled();
  expect(await f.vault.read(f.file)).toBe(raw);
  await expect(f.store.acquire(f.snapshot, 'Replacement', 'Publisher')).rejects.toThrow();
  expect(() => acquireBody(raw, raw, 'Replacement', 'Publisher')).toThrow();
});

it('bounds native-capture body reads and cancels queued/running acquisitions on retirement', async () => {
  const f = await fixture(),
    pending = gate(),
    entered = gate();
  let active = 0;
  extraction.mockImplementation(async () => {
    if (++active === 2) entered.resolve();
    await pending.promise;
    return { markdown: 'Text', title: '' };
  });
  const files = [f.file];
  for (let i = 0; i < 4; i++)
    files.push(await f.vault.create(`Reading/Inbox/Native ${i}.md`, sample));
  const read = vi.spyOn(f.vault, 'read');
  const results = files.map((file) => f.ingestion.acquire(file.path).catch((error) => error));
  await entered.promise;
  expect(read).toHaveBeenCalledTimes(2);
  f.ingestion.stop();
  pending.resolve();
  expect((await Promise.all(results)).every((result) => result instanceof Error)).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  expect([...f.vault.bytes.values()]).toEqual(Array(5).fill(sample));
});

it('revalidates placeholder bytes at the document boundary without an ingestion receipt', () => {
  expect(readDocument(acquireBody(sample, sample, 'Text', '')).body.trim()).toBe('Text');
  expect(() => acquireBody(sample + 'annotation', sample, 'Text', '')).toThrow();
});

it('keeps explicit empty titles and unknown YAML while replacing a placeholder', async () => {
  const f = await fixture(
    createDocument({ type: 'article', url, title: '', custom: { untouched: 1 } }, placeholder),
  );
  await f.ingestion.acquire(f.file.path);
  expect(readDocument(await f.vault.read(f.file)).properties).toMatchObject({
    title: '',
    custom: { untouched: 1 },
  });
  expect(readDocument(await f.vault.read(f.file)).body.trim()).toBe('Downloaded article.');
});

it('protects current-body edits when a placeholder acquisition settles', async () => {
  const f = await fixture(),
    pending = gate(),
    entered = gate();
  extraction.mockImplementation(async () => {
    entered.resolve();
    await pending.promise;
    return { markdown: 'Text', title: '' };
  });
  const result = f.ingestion.acquire(f.file.path).catch((error) => error);
  await entered.promise;
  await f.vault.process(f.file, (raw) => raw + '\n==My annotation==');
  const edited = await f.vault.read(f.file);
  pending.resolve();
  expect(await result).toBeInstanceOf(Error);
  expect(await f.vault.read(f.file)).toBe(edited);
});
