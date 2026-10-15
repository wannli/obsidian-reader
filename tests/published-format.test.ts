import { expect, it, vi } from 'vitest';
import type { TFile } from 'obsidian';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(async () => ({ text: '<rss/>', status: 200, headers: {} })),
}));
vi.mock('../src/content/feed', () => ({
  parseFeed: () => ({ title: 'Example', items: [] }),
  feedMarkdown: vi.fn(),
}));
vi.mock('../src/content/extract', () => ({ extract: vi.fn() }));
import { Ingestion } from '../src/host/ingestion';
import { createDocument, patchProperties, readDocument, savePosition } from '../src/core/document';
import { articleInfo, filename, formatPublished, timestamp } from '../src/core/model';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

it('creates useful subscription properties without IDs and preserves unknown fields on duplicate subscribe', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const ingestion = new Ingestion(store as unknown as ArticleStore<TFile>, vi.fn());
  try {
    await ingestion.subscribe('https://example.com/feed');
    const file = vault.file(store.catalog.feeds()[0].path)!;
    expect(readDocument(await vault.read(file)).properties).toEqual({
      type: 'feed',
      url: 'https://example.com/feed',
      title: expect.any(String),
      prefix: expect.any(String),
      enabled: true,
    });
    await vault.process(file, (raw) =>
      patchProperties(raw, { id: 'old-id', ID: 'old-upper-id', custom: 'keep', enabled: false }),
    );
    const before = await vault.read(file);
    store.catalog.update(file.path, readDocument(before).properties);
    await ingestion.subscribe('https://example.com/feed');
    expect(vault.files.size).toBe(1);
    expect(await vault.read(file)).toBe(before);
  } finally {
    ingestion.stop();
  }
});

const minute = '2026-10-03T04:29';
const legacy = ['2026-10-03', '2026-10-03T04:29:53.123Z', '2026-10-03T06:29:53+02:00', minute];

it.each(['2026-10-03T04:29:59.999', '2026-10-03T04:29:00', minute])(
  'formats a new local publication %s without rounding seconds',
  (input) => {
    expect(formatPublished(input)).toBe(minute);
  },
);

it.each([undefined, null, 0, '', 'not a date', '2026-02-30', '2026-10-03T04:60'])(
  'does not invent a publication for invalid or missing input %j',
  (input) => {
    expect(formatPublished(input)).toBeUndefined();
  },
);

it.each([[new Date(2026, 9, 3, 4, 29, 59, 999).toISOString(), minute]])(
  'capture writes an unquoted Obsidian minute and a UTC filename for %s',
  async (published, expected) => {
    const vault = new MemoryVault(),
      store = new ArticleStore(vault);
    const input = {
      url: 'https://example.com/article',
      title: 'Example',
      published,
      body: 'Authored text.',
    };
    const file = await store.capture(input);
    const raw = await vault.read(file);
    expect(raw).toContain(`\npublished: ${expected}\n`);
    expect(readDocument(raw).properties.published).toBe(expected);
    expect(file.path).toBe(
      `Reading/Articles/${filename('Example', new Date(published), '', true)}`,
    );
    expect(readDocument(raw).body).toBe('\nAuthored text.\n');
    expect(input.published).toBe(published);
  },
);

it.each([undefined, '', 'invalid', '2026-02-30T04:29:00Z'])(
  'capture falls back from invalid/missing publication %j to local capture time and naming',
  async (published) => {
    const vault = new MemoryVault(),
      store = new ArticleStore(vault),
      now = new Date('2026-10-14T00:30:00Z');
    const file = await store.capture(
      { url: 'https://example.com/article', title: 'Example', published },
      now,
    );
    const raw = await vault.read(file);
    expect(readDocument(raw).properties.published).toBe(formatPublished(now.toISOString()));
    expect(raw).toContain(`\npublished: ${formatPublished(now.toISOString())}\n`);
    expect(file.path).toBe(`Reading/Articles/${filename('Example', now)}`);
  },
);

it('freezes the original capture time before queued work and caller clock mutation', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const now = new Date(2026, 9, 3, 4, 29, 59),
    original = now.toISOString();
  const pending = store.capture({ url: 'https://example.com/frozen' }, now);
  now.setFullYear(2030);
  const file = await pending;
  expect(readDocument(await vault.read(file)).properties.published).toBe(formatPublished(original));
  expect(file.path).toContain('261003');
});

it('does not backfill a legacy missing publication on duplicate capture', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const raw = createDocument({ type: 'article', url: 'https://example.com/legacy' }, 'Authored.');
  const file = await vault.create('Reading/Articles/Legacy.md', raw);
  store.catalog.update(file.path, readDocument(raw).properties);
  expect(await store.capture({ url: 'https://example.com/legacy' })).toBe(file);
  expect(await vault.read(file)).toBe(raw);
});

it('uses a plain scalar only for a valid canonical published value, not other strings', () => {
  const raw = createDocument({ type: 'article', published: minute, custom: minute, title: 'true' });
  expect(raw).toContain(`\npublished: ${minute}\n`);
  expect(raw).toContain(`\ncustom: "${minute}"\n`);
  expect(raw).toContain('\ntitle: "true"\n');
  expect(readDocument(raw).properties).toEqual({
    type: 'article',
    published: minute,
    custom: minute,
    title: 'true',
  });
});

it.each([
  '2026-10-03',
  '2026-10-03T04:29:53.123Z',
  '2026-10-03T06:29:53+02:00',
  '2026-02-30T04:29',
  'not a date',
])(
  'ordinary property writes do not normalize %s or emit it as a canonical plain scalar',
  (published) => {
    const raw = patchProperties(createDocument({ type: 'article' }), { published });
    expect(raw).toContain(`\npublished: "${published}"\n`);
    expect(readDocument(raw).properties.published).toBe(published);
  },
);

it.each(legacy)(
  'preserves existing published %s, quotes and comments through unrelated edits and dedupe',
  async (published) => {
    const raw = `---\ntype: article\nurl: https://example.com/article\npublished: "${published}" # keep publication\ncustom: 'unchanged' # keep custom\n---\nAuthored ==text==.\n`;
    const updated = savePosition(patchProperties(raw, { title: 'Edited title' }), 'Authored text');
    expect(updated).toContain(`published: "${published}" # keep publication`);
    expect(updated).toContain("custom: 'unchanged' # keep custom");
    expect(readDocument(updated).body).toBe(readDocument(raw).body);
    expect(readDocument(updated).properties.published).toBe(published);
    const vault = new MemoryVault(),
      store = new ArticleStore(vault);
    const file = await vault.create('Reading/Treasury/Existing.md', updated);
    store.catalog.update(file.path, readDocument(updated).properties);
    const duplicate = await store.capture({
      url: 'https://example.com/article',
      published: '2026-10-14T12:00:59Z',
    });
    expect(duplicate).toBe(file);
    expect(await vault.read(file)).toBe(updated);
    expect(vault.files.size).toBe(1);
  },
);

it.each([
  ['2026-10-03', '2026-10-03T00:00:00.000Z'],
  ['2026-10-03T04:29:53.123Z', '2026-10-03T04:29:53.123Z'],
  ['2026-10-03T06:29:53.123+02:00', '2026-10-03T04:29:53.123Z'],
])('keeps legacy %s readable at its original instant', (published, instant) => {
  const expected = Date.parse(instant);
  expect(timestamp(published)).toBe(expected);
  expect(
    articleInfo('Reading/Articles/Example.md', { type: 'article', status: 'feed', published })
      ?.date,
  ).toBe(expected);
});

it('preserves strict instant expiry for existing explicit-zone values, including subminute boundaries', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const publications = [
    '2026-10-03T04:29:29.999Z',
    '2026-10-03T04:29:30.000Z',
    '2026-10-03T06:29:59.999+02:00',
  ];
  for (const [index, published] of publications.entries()) {
    const properties = { type: 'article', status: 'feed', published };
    const file = await vault.create(
      `Reading/Stream/${index}.md`,
      createDocument(properties, 'Publisher body.'),
    );
    store.catalog.update(file.path, properties);
  }
  expect(await store.expire(new Date('2026-11-03T04:29:30.000Z'))).toEqual({
    deleted: 1,
    promoted: 0,
    retained: 0,
  });
  expect(vault.trashed).toEqual(['Reading/Stream/0.md']);
  expect(store.catalog.list('Feed').map((article) => article.path)).toEqual([
    'Reading/Stream/2.md',
    'Reading/Stream/1.md',
  ]);
});
