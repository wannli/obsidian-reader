import { expect, it, vi } from 'vitest';
import { nodesApi, NODE_COLORS, suggestedNodeTitle } from '../src/nodes-api';
import { setInlineNodeLink, removeInlineHighlight } from '../src/inline/edit';
import { parseInlineMarkdown } from '../src/inline/parser';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
import { ReaderController } from '../src/controller';
import { mountReader } from '../src/ui/reader';
const id = (text: string) => parseInlineMarkdown(text).highlights[0].id;
const node = { path: 'People/Ada.md', title: 'Ada', type: 'Person', aliases: ['Countess'], color: 'blue' as const };
const path = 'Reading/Inbox/Test.md', source = '---\ntype: article\ncustom: keep\n---\nBefore ==the Countess== after.';
it('requires all version-one API capabilities and rechecks enablement', () => {
  expect(nodesApi({})).toBeNull();
  let api: unknown = { version: 2 };
  const app = { plugins: { getPlugin: vi.fn(() => ({ api })) } };
  expect(nodesApi(app)).toBeNull();
  api = { version: 1, listTypes() {}, searchNodes() {}, getNode() {}, createNode() {} };
  expect(nodesApi(app)).toBe(api); api = undefined; expect(nodesApi(app)).toBeNull();
  expect(app.plugins.getPlugin).toHaveBeenCalledWith('obsidian-nodes');
});
it('suggests short titles, not whole long passages', () => {
  expect(suggestedNodeTitle('Ada Lovelace')).toBe('Ada Lovelace');
  expect(suggestedNodeTitle('long passage '.repeat(20))).toBeUndefined();
});
it.each(Object.values(NODE_COLORS))('links original words with schema color %s, changes target, unlinks retaining highlight', color => {
  const raw = 'Before ==the Countess== after.';
  const linked = setInlineNodeLink(raw, id(raw), node.path, color);
  expect(linked).toBe(`Before ==${color}[[People/Ada.md|the Countess]]== after.`);
  const changed = setInlineNodeLink(linked, id(linked), 'Custom/Another.md');
  expect(changed).toBe('Before ==[[Custom/Another.md|the Countess]]== after.');
  expect(setInlineNodeLink(changed, id(changed), null)).toBe(raw);
  expect(removeInlineHighlight(changed, id(changed), {}, true)).toBe('Before the Countess after.');
});
it.each(['==🟡[[Ada|the Countess]]==', '==[[Custom/Ada.md|the Countess]]==', '==🔵[the *Countess*](<People/Ada.md>)=='])('handles aliases, short targets and formatted links: %s', raw => {
  const plain = setInlineNodeLink(raw, id(raw), null);
  expect(parseInlineMarkdown(plain).canonicalText).toBe('the Countess');
  expect(parseInlineMarkdown(plain).links).toHaveLength(0);
  expect(parseInlineMarkdown(plain).highlights).toHaveLength(1);
});
it('rejects stale and partial/nested links rather than changing words', () => {
  const raw = '==words==';
  expect(() => setInlineNodeLink(raw + ' changed', id(raw), node.path)).toThrow('changed');
  const partial = '==some [[Ada|words]]==';
  expect(() => setInlineNodeLink(partial, id(partial), node.path)).toThrow();
});
it('uses API color, preserves node bytes and unknown article data; ordinary links ignore legacy settings', async () => {
  const nodeText = '---\ntype: Person\n---\nAuthored biography';
  const store = new MemoryStore({ [path]: source, [node.path]: nodeText });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  let article = await repo.setNodeLink(path, (await repo.getArticle(path)).highlights[0].id, node);
  expect(article.highlights[0].color).toBe('🔵');
  article = await repo.setNodeLink(path, article.highlights[0].id, null);
  expect(article.highlights[0].quote).toBe('the Countess');
  expect(await store.read(node.path)).toBe(nodeText);
  expect(await store.read(path)).toContain('custom: keep');
  article = await repo.setHighlightLink(path, article.highlights[0].id, node.path);
  expect(article.highlights).toHaveLength(0); expect(article.body).not.toContain('🔵');
});
it('keeps API-created nodes on stale source or schema/enablement failure', async () => {
  const store = new MemoryStore({ [path]: source, [node.path]: '---\ntype: Person\n---\n' });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS), article = await repo.getArticle(path);
  await store.process(path, raw => raw + ' User edit');
  await expect(repo.setNodeLink(path, article.highlights[0].id, node)).rejects.toThrow();
  const current = await repo.getArticle(path);
  await expect(repo.setNodeLink(path, current.highlights[0].id, node, () => { throw new Error('Schema changed'); })).rejects.toThrow('Schema changed');
  expect(await store.exists(node.path)).toBe(true); expect(await store.read(path)).toBe(source + ' User edit');
});
it('offers optional node action without independent types and cancellation makes no writes', async () => {
  const store = new MemoryStore({ [path]: source }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const controller = new ReaderController(repo, vi.fn(), DEFAULT_SETTINGS), root = document.createElement('div'); document.body.append(root);
  const pickNode = vi.fn(() => () => {});
  const stop = mountReader(root, await repo.getArticle(path), controller, { openNote: vi.fn(), pickNode }, () => {});
  try {
    document.getSelection()?.removeAllRanges(); root.querySelector('mark')!.click();
    const buttons = [...root.querySelectorAll('button')];
    expect(buttons.some(button => button.textContent === '🟡 person')).toBe(false);
    buttons.find(button => button.textContent === 'Link to node…')!.click();
    expect(pickNode).toHaveBeenCalled(); expect(await store.read(path)).toBe(source);
  } finally { await stop(); root.remove(); await controller.shutdown(); }
});

it.each(['Nodes/Ada', 'Custom/Ada', 'Ada'])('ordinary link removal never infers node ownership from folder: %s', target => {
  const raw = `==[[${target}|words]]==`;
  expect(removeInlineHighlight(raw, id(raw))).toBe(`[[${target}|words]]`);
  expect(removeInlineHighlight(raw, id(raw), {}, true)).toBe('words');
});
