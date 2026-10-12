import { expect, it, vi } from 'vitest';
import { nativeStore } from './helpers/native-store';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
const path = 'Reading/Inbox/Guard.md', node = 'Nodes/Ada Lovelace.md';
const source = '---\ntype: article\n---\n==Ada Lovelace==';
const nodeText = '---\ntype: person\n---\n';
const person = { path: node, title: 'Ada Lovelace', type: 'person', aliases: [] as string[], color: 'yellow' } as const;
const staleNodeFence = /Node changed/;

it('linking an existing typed node rejects a type change before the article commit', async () => {
  const f = nativeStore({ [path]: source, [node]: nodeText }), repo = new ReaderRepository(f.store, DEFAULT_SETTINGS);
  const article = await repo.getArticle(path);
  f.hooks.beforeProcess = async file => {
    if (file.path !== path) return;
    f.hooks.beforeProcess = undefined;
    await f.store.process(node, () => '---\ntype: topic\n---\n');
  };
  await expect(repo.setNodeLink(path, article.highlights[0].id, person)).rejects.toThrow();
  expect(f.disk.get(path)).toBe(source);
  expect(f.disk.get(node)).toContain('type: topic');
});

it('native unhighlight keeps an unreferenced empty typed node unchanged', async () => {
  const f = nativeStore({ [path]: source, [node]: nodeText }), repo = new ReaderRepository(f.store, DEFAULT_SETTINGS);
  const typed = await repo.setNodeLink(path, (await repo.getArticle(path)).highlights[0].id, person);
  await repo.deleteHighlight(path, typed.highlights[0].id);
  expect(f.disk.get(node)).toBe(nodeText);
  expect(f.disk.get(path)).toContain('Ada Lovelace');
  expect(f.disk.get(path)).not.toContain('[[Nodes/');
});

it('rejects target type changes after preflight but before article callback', async () => {
  const store = new MemoryStore();
  await store.create(path, source); await store.create(node, nodeText);
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS), article = await repo.getArticle(path), process = store.process.bind(store);
  vi.spyOn(store, 'process').mockImplementation(async (target, update) => {
    if (target === path) await process(node, () => '---\ntype: topic\n---\n');
    return process(target, update);
  });
  try {
    await expect(repo.setNodeLink(path, article.highlights[0].id, person)).rejects.toThrow(staleNodeFence);
    expect(await store.read(path)).toBe(source); expect(await store.read(node)).toContain('type: topic');
  } finally { vi.restoreAllMocks(); }
});

it.each(['type', 'delete', 'replace', 'buffer', 'rename'])('native target %s change immediately before article process blocks the write', async change => {
  const f = nativeStore({ [path]: source, [node]: nodeText });
  const repo = new ReaderRepository(f.store, DEFAULT_SETTINGS), article = await repo.getArticle(path);
  const view = change === 'buffer' ? f.open(node) : undefined;
  let articleProcesses = 0;
  f.hooks.beforeProcess = async file => {
    if (file.path !== path || ++articleProcesses < 1) return; // Skip read-only source preflight.
    f.hooks.beforeProcess = undefined;
    if (change === 'type') await f.store.process(node, () => '---\ntype: topic\n---\n');
    else if (change === 'buffer') view!.editor.value = '---\ntype: topic\n---\n';
    else if (change === 'rename') await f.vault.rename(f.files.get(node)!, 'Nodes/Renamed.md');
    else {
      const original = f.files.get(node)!;
      f.files.delete(node); f.disk.delete(node); f.vault.trigger('delete', original);
      if (change === 'replace') await f.vault.create(node, nodeText);
    }
  };
  await expect(repo.setNodeLink(path, article.highlights[0].id, person)).rejects.toThrow(staleNodeFence);
  expect(f.disk.get(path)).toBe(source);
  expect(f.events.filter(event => event.path === path)).toEqual([]);
});

it('detects a target change while native article save is pending and honestly reports possible saved highlight', async () => {
  const f = nativeStore({ [path]: source, [node]: nodeText });
  const repo = new ReaderRepository(f.store, DEFAULT_SETTINGS), article = await repo.getArticle(path), editor = f.open(path);
  editor.view.gateSave = async () => { await f.store.process(node, () => '---\ntype: topic\n---\n'); };
  await expect(repo.setNodeLink(path, article.highlights[0].id, person)).rejects.toThrow('link may already be saved');
  expect(f.disk.get(path)).toContain('==🟡[[Nodes/Ada Lovelace.md|Ada Lovelace]]==');
  expect(f.disk.get(node)).toBe('---\ntype: topic\n---\n');
});

it('rechecks exact target bytes after saving when an external change has not yet emitted a vault event', async () => {
  const f = nativeStore({ [path]: source, [node]: nodeText });
  const repo = new ReaderRepository(f.store, DEFAULT_SETTINGS), article = await repo.getArticle(path), editor = f.open(path);
  editor.view.gateSave = async () => { f.disk.set(node, '---\ntype: topic\n---\n'); };
  await expect(repo.setNodeLink(path, article.highlights[0].id, person)).rejects.toThrow('Could not verify');
  expect(f.disk.get(node)).toContain('type: topic');
});

it.each(['empty lowercase folder', 'nonmarkdown child', 'nonmarkdown blocking file', 'target folder', 'case-equivalent target'])('native full-entry checks reject %s', async collision => {
  const f = nativeStore({ [path]: source });
  if (collision === 'empty lowercase folder') await f.vault.createFolder('nodes');
  if (collision === 'nonmarkdown child') await f.vault.create('nodes/photo.png', 'image');
  if (collision === 'nonmarkdown blocking file') await f.vault.create('Nodes', 'binary');
  if (collision === 'target folder') await f.vault.createFolder('Nodes/ada lovelace.md');
  if (collision === 'case-equivalent target') await f.vault.create('Nodes/ADA LOVELACE.md', nodeText);
  if (collision !== 'case-equivalent target') expect(await f.store.list()).toEqual([path]); // Normal article listing cannot see these entries.
  const repo = new ReaderRepository(f.store, DEFAULT_SETTINGS), article = await repo.getArticle(path);
  await expect(repo.setNodeLink(path, article.highlights[0].id, person)).rejects.toThrow('ambiguous');
  expect(f.disk.get(path)).toBe(source); expect(f.disk.has(node)).toBe(false);
});

it('authoritative creation preflight sees unsaved native source changes before UI refresh', async () => {
  const f = nativeStore({ [path]: source }), repo = new ReaderRepository(f.store, DEFAULT_SETTINGS);
  const article = await repo.getArticle(path), view = f.open(path);
  view.editor.value = source + ' unsaved edit';
  await expect(repo.validateNodeHighlight(path, article.highlights[0].id)).rejects.toThrow('changed');
  expect(f.disk.get(path)).toBe(source);
});
