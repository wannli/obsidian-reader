import { expect, it } from 'vitest';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';
import { sidecarPath } from './sidecar-helpers';
import { articlePath } from '../src/storage/article-path';

const path = 'Reading/Inbox/Legacy.md';
const quoted = '---\ntype: article\nhighlights:\n  - id: hl-old\n    created: 2020-01-01\n    day: 2020-01-01\n    dailyPath: Daily/2020-01-01.md\n---\n## Highlights\n\n> Quoted words.\n\n^hl-old\n\n## Article\n\nQuoted words.\n';
const plain = '---\ntype: article\npullmanFormat: inline-v1\n---\nCurrent text.\n';

it('does not convert quote blocks or highlight arrays, including on restart', async () => {
  const store = new MemoryStore({ [path]: quoted }), before = store.snapshot();
  for (let restart = 0; restart < 2; restart++) {
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect((await repo.prepareStorage()).errors.join(' ')).toMatch(/highlight array|quote blocks/i);
    await expect(repo.addHighlight(path, { quote: 'Quoted words.' })).rejects.toThrow(/blocked|legacy/i);
    expect(store.snapshot()).toEqual(before);
  }
});

it.each([
  ['pending queueMove', plain.replace('pullmanFormat: inline-v1', 'pullmanFormat: inline-v1\nqueueMove: {from: Reading/Inbox/Legacy.md, to: Reading/Later/Legacy.md}')],
  ['receipt fields', plain.replace('pullmanFormat: inline-v1', 'pullmanFormat: inline-v1\npullmanLegacyHash: ' + 'a'.repeat(64))],
  ['unknown format marker', plain.replace('inline-v1', 'future-format')],
  ['recognizable unconverted quote', plain.replace('pullmanFormat: inline-v1\n', '') + '\n> Old excerpt.\n\n^hl-stale\n'],
])('blocks %s while preserving every byte', async (_label, raw) => {
  const store = new MemoryStore({ [path]: raw }), before = store.snapshot(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors.length).toBeGreaterThan(0);
  await expect(repo.setArticleError(path, 'must not write')).rejects.toThrow(/blocked|legacy/i);
  expect(store.snapshot()).toEqual(before);
});

it('protects both endpoints of a YAML queueMove against path reuse', async () => {
  const destination = articlePath({ title: 'Move target', url: '', status: 'later' }, []);
  const pending = plain.replace('pullmanFormat: inline-v1', 'pullmanFormat: inline-v1\nqueueMove: {from: ' + path + ', to: ' + destination + '}');
  const store = new MemoryStore({ [path]: pending }), before = store.snapshot(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors.join(' ')).toMatch(/queueMove/i);
  await expect(repo.createArticle({ title: 'Move target', url: '', status: 'later', body: 'Do not reuse' })).rejects.toThrow(/queueMove|legacy|blocked/i);
  expect(store.snapshot()).toEqual(before);
});

it('reports malformed/conflicting JSON and blocks updates without changing either file', async () => {
  const jsonPath = sidecarPath(path), json = '{"schema":1,"path":"elsewhere.md","path":"' + path + '","metadata":{"content":"ready"}}';
  const store = new MemoryStore({ [path]: plain, [jsonPath]: json }), repo = new ReaderRepository(store, DEFAULT_SETTINGS), before = store.snapshot();
  expect((await repo.prepareStorage()).errors.length).toBeGreaterThan(0);
  await expect(repo.setStatus(path, 'later')).rejects.toThrow(/blocked|legacy/i);
  expect(store.snapshot()).toEqual(before);
});
