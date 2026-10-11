import { expect, it } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
import { parseNote } from '../src/storage/markdown';
const path = 'Reading/Inbox/YAML.md', person = '---\ntype: person\n---\n';
it.each(['\n', '\r\n'])('only splices the relationship value, preserving unrelated YAML bytes with newline %j', async nl => {
  const prefix = ['---', 'type: article', '# Before', "author: 'Legacy author'", 'custom: [one,two] # exact spacing', 'authors:'].join(nl) + nl;
  const property = ['  - "[[People/Ada]]" # assignment comment', ''].join(nl);
  const suffix = ['other: |', '  This stays exactly.', '# After', '---', '==Body==', ''].join(nl);
  const store = new MemoryStore({ [path]: prefix + property + suffix, 'People/Ada.md': person, 'People/Charles.md': person }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await repo.updateArticleAuthors(path, { add: ['People/Charles.md'] }); const raw = await store.read(path);
  expect(raw.startsWith(prefix)).toBe(true); expect(raw.endsWith(suffix)).toBe(true);
  expect(parseNote(raw).doc.toJS().authors).toEqual(['[[People/Ada]]', '[[People/Charles]]']);
});
it('removes only the relationship property and its inline comment when the final assignment is removed', async () => {
  const before = '---\ntype: article\nauthor: "Legacy"\nauthors: ["[[People/Ada]]"] # assigned\ncustom: [one,two]\n---\nBody\n';
  const store = new MemoryStore({ [path]: before }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await repo.updateArticleAuthors(path, { remove: ['People/Ada.md'] });
  expect(await store.read(path)).toBe(before.replace('authors: ["[[People/Ada]]"] # assigned\n', ''));
});
it('preserves BOM, quoted key, comments and existing single-quoted relationship labels', async () => {
  const before = '\uFEFF---\ntype: article\n"authors": [\'[[People/Ada]]\'] # note\ncustom: {a: 1,b: 2}\n---\nBody\n';
  const store = new MemoryStore({ [path]: before, 'People/Charles.md': person }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await repo.updateArticleAuthors(path, { add: ['People/Charles.md'] }); const raw = await store.read(path);
  expect(raw.startsWith('\uFEFF---\ntype: article\n"authors": ')).toBe(true);
  expect(raw.endsWith(' # note\ncustom: {a: 1,b: 2}\n---\nBody\n')).toBe(true);
  expect(parseNote(raw).doc.toJS().authors).toEqual(['[[People/Ada]]', '[[People/Charles]]']);
});
it('unsupported flow-root YAML fails preflight before any explicit nodes are created', async () => {
  const before = '---\n{type: article, custom: keep}\n---\nBody';
  const store = new MemoryStore({ [path]: before }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await expect(repo.updateArticleAuthors(path, { create: ['New'] })).rejects.toThrow(); expect(store.snapshot()).toEqual({ [path]: before });
});
