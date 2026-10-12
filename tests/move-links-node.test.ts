import { expect, it } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';

const path = 'Reading/Inbox/Test.md';
const node = { path: 'People/Ada.md', title: 'Ada', type: 'Person', aliases: [], color: 'blue' as const };

it.each([
  ['the Countess', '==🔵[[People/Ada.md|the Countess]]=='],
  ['the *Countess*', '==🔵[the *Countess*](People/Ada.md)=='],
  ['the Countess &amp; friend', '==🔵[the Countess &amp; friend](People/Ada.md)=='],
])('archives actual node-link output without changing any bytes: %s', async (label, output) => {
  const store = new MemoryStore({ [path]: `---\ntype: article\ncustom: keep\n---\nBefore ==${label}== after.`, [node.path]: '---\ntype: Person\n---\nBiography' });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.getArticle(path);
  await repo.setNodeLink(path, article.highlights[0].id, node);
  const linked = await store.read(path);
  expect(linked).toContain(output);
  const before = store.snapshot();
  const moved = await repo.setStatus(path, 'archive');
  expect(moved.path).toBe('Reading/Treasury/Test.md');
  expect(store.snapshot()).toEqual({ [moved.path]: linked, [node.path]: before[node.path] });
});

it.each([
  ['People/Ada Lovelace.md', '==🔵[the *Countess*](<People/Ada Lovelace.md>)=='],
  ['People/Élodie.md', '==🔵[the *Countess*](People/Élodie.md)=='],
  ['People/Élodie Dupont.md', '==🔵[the *Countess*](<People/Élodie Dupont.md>)=='],
])('archives actual generated destination syntax for %s', async (target, output) => {
  const store = new MemoryStore({ [path]: '---\ntype: article\n---\n==the *Countess*==', [target]: '---\ntype: Person\n---\nBiography' });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await repo.setNodeLink(path, (await repo.getArticle(path)).highlights[0].id, { ...node, path: target });
  const linked = await store.read(path);
  expect(linked).toContain(output);
  const before = store.snapshot();
  const moved = await repo.setStatus(path, 'archive');
  expect(store.snapshot()).toEqual({ [moved.path]: linked, [target]: before[target] });
});

it.each([
  ['[Ada](../../People/Ada.md)', { 'People/Ada.md': 'Ada' }],
  ['[Ada](<People/Ada Lovelace.md>)', { 'People/Ada Lovelace.md': 'Ada' }],
])('allows an unchanged uniquely resolved Markdown destination: %s', async (link, files) => {
  const raw = '---\ntype: article\n---\n' + link;
  const store = new MemoryStore({ [path]: raw, ...files });
  const moved = await new ReaderRepository(store, DEFAULT_SETTINGS).setStatus(path, 'archive');
  expect(await store.read(moved.path)).toBe(raw);
});

it.each([
  ['[Ada](People/Ada.md)', {}],
  ['[Ada](People/Ada.md)', { 'People/Ada.md': 'Ada', 'Other/People/Ada.md': 'Other' }],
  ['[Ada](People/Ada.md)', { 'People/Ada.md': 'Ada', 'Reading/Treasury/People/Ada.md': 'Shadow' }],
  ['[Ada](./Ada.md)', { 'Reading/Inbox/Ada.md': 'Old', 'Reading/Treasury/Ada.md': 'New' }],
  ['[Ada](../missing.md)', {}],
  ['![photo](./photo.png)', { 'Reading/Inbox/photo.png': 'bytes' }],
  ['[Ada][person]\n[person]: People/Ada.md', { 'People/Ada.md': 'Ada' }],
  ['<a href="People/Ada.md">Ada</a>', { 'People/Ada.md': 'Ada' }],
  ['[Ada](People/Ada&amp;Co.md)', { 'People/Ada&Co.md': 'Ada' }],
  ['[Ada](People/Ada.md) [unknown](./missing.md)', { 'People/Ada.md': 'Ada' }],
  ['[Ada](People/Ada.md#Heading)', { 'People/Ada.md': 'Ada' }],
  ['[Ada](People/Ada%20Lovelace.md)', { 'People/Ada Lovelace.md': 'Ada' }],
  ['[Ada](People/%C3%89lodie.md)', { 'People/Élodie.md': 'Biography' }],
  ['[Ada](People/Élodie.md)', { 'People/Élodie.md': 'Composed', 'People/E\u0301lodie.md': 'Decomposed' }],
  ['[Ada](People/Élodie.md)', { 'People/Élodie.md': 'Ada', 'Other/People/Élodie.md': 'Shadow' }],
  ['[Ada](../../../People/Ada.md)', { 'People/Ada.md': 'Ada' }],
  ['[Ada](People/../People/Ada.md)', { 'People/Ada.md': 'Ada' }],
])('still refuses unknown, changing, ambiguous or unsupported links without writes: %s', async (link, files) => {
  const store = new MemoryStore({ [path]: '---\ntype: article\n---\n' + link, ...files });
  const before = store.snapshot();
  await expect(new ReaderRepository(store, DEFAULT_SETTINGS).setStatus(path, 'archive')).rejects.toThrow('Queue move deferred:');
  expect(store.snapshot()).toEqual(before);
});
