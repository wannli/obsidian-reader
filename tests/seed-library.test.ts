import { mark } from './markdown-helpers';
import { expect, it } from 'vitest';
// @ts-expect-error Node-only setup tooling intentionally has no TypeScript declarations.
import { seedFiles, seedBody, seedTitle } from '../scripts/seed.mjs';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
import { parseNote } from '../src/storage/markdown';

it('synthetic seeds use actual YAML state, no active sidecars, and preserve source/journals', async () => {
  const files = seedFiles('2026-10-09') as Record<string, string>;
  const store = new MemoryStore(files), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const path = `Reading/Inbox/261009 ${seedTitle}.md`;
  expect(Object.keys(files).filter(path => /^Reading\/.*\.json$/.test(path))).toEqual([]);
  for (const notePath of Object.keys(files).filter(path => /^Reading\/.*\.md$/.test(path))) {
    const note = parseNote(files[notePath]);
    expect(note.doc.has('id')).toBe(note.doc.get('type') === 'feed');
    if (note.doc.get('type') === 'article') for (const key of ['guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength']) expect(note.doc.has(key)).toBe(false);
  }
  expect(await repo.listArticles()).toHaveLength(4); expect(await repo.listFeeds()).toHaveLength(1);
  expect((await repo.getArticle(path)).body).toBe(seedBody);
  const highlighted = await mark(repo, path, { quote: 'Small observations become durable knowledge' });
  expect(highlighted.body).toBe(seedBody.replace('Small observations become durable knowledge', '==Small observations become durable knowledge=='));
  expect(highlighted.highlights).toHaveLength(1);
  expect(store.snapshot()['Daily/2026-10-09.md']).toBe(files['Daily/2026-10-09.md']);
});
