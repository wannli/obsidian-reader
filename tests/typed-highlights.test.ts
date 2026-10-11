import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { HIGHLIGHT_COLORS, typedNodeTarget, validateHighlightTypes } from '../src/typed-highlights';
import { parseInlineMarkdown } from '../src/inline/parser';
import { removeInlineHighlight, setInlineHighlightLink, setInlineHighlightType, addInlineHighlight } from '../src/inline/edit';
import { inlineMarked } from '../src/inline/syntax';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { ReaderController } from '../src/controller';
import { mountReader } from '../src/ui/reader';
const person = { name: 'person', color: '🟡' } as const;
const path = 'Reading/Inbox/Test.md';
const initial = '---\ntype: article\ntitle: Test\ncustom: keep\nreading_position: "Ada Lovelace"\n---\nBefore ==Ada Lovelace== after.\n';
const node = 'Nodes/Ada Lovelace.md';
afterEach(() => { document.getSelection()?.removeAllRanges(); });
it.each(HIGHLIGHT_COLORS)('maps native %s color without counting emoji in text or source anchors', color => {
  const source = `😀 ==${color}[[Nodes/Ada Lovelace|Ada Lovelace]]== after`;
  const parsed = parseInlineMarkdown(source);
  expect(parsed.canonicalText).toBe('😀 Ada Lovelace after');
  expect(parsed.highlights[0]).toMatchObject({ quote: 'Ada Lovelace', color, link: 'Nodes/Ada Lovelace', anchor: { start: 2, end: 14 } });
  expect(parsed.links[0].source.start).toBe(source.indexOf('[['));
  expect(inlineMarked.parse(source)).not.toContain(color);
  const next = addInlineHighlight(source, { quote: 'after', revision: parsed.revision });
  expect(next).toBe(source.replace('after', '==after=='));
  expect(removeInlineHighlight(source, parsed.highlights[0].id)).toBe('😀 Ada Lovelace after');
});
it('types only verified plain words; ordinary Link still removes highlight syntax', () => {
  const source = 'Before ==Ada Lovelace== after.';
  const id = parseInlineMarkdown(source).highlights[0].id;
  expect(setInlineHighlightType(source, id, person)).toBe('Before ==🟡[[Nodes/Ada Lovelace|Ada Lovelace]]== after.');
  expect(setInlineHighlightLink(source, id, 'Ada Lovelace')).toBe('Before [[Ada Lovelace]] after.');
  expect(() => setInlineHighlightType(source + 'changed', id, person)).toThrow();
  const formatted = '==**Ada Lovelace**==';
  expect(() => setInlineHighlightType(formatted, parseInlineMarkdown(formatted).highlights[0].id, person)).toThrow('plain words');
});
it.each(['*', '_'] as const)('types a complete %s-italicized highlight without losing formatting', delimiter => {
  const source = `Before ==${delimiter}Ada Lovelace${delimiter}== after.`;
  const id = parseInlineMarkdown(source).highlights[0].id;
  const typed = setInlineHighlightType(source, id, person);
  expect(typed).toBe(`Before ==🟡\u005b${delimiter}Ada Lovelace${delimiter}](<Nodes/Ada Lovelace>)== after.`);
  expect(parseInlineMarkdown(typed).highlights[0]).toMatchObject({ quote: 'Ada Lovelace', link: 'Nodes/Ada Lovelace' });
  expect(removeInlineHighlight(typed, parseInlineMarkdown(typed).highlights[0].id)).toBe(`Before ${delimiter}Ada Lovelace${delimiter} after.`);
  expect(setInlineHighlightType(typed, parseInlineMarkdown(typed).highlights[0].id, { name: 'location', color: '🔵' })).toContain('==🔵');
});
it('can select the entire italic span before creating its node', () => {
  const source = 'Before *Ada Lovelace* after.';
  const marked = addInlineHighlight(source, { quote: 'Ada Lovelace', revision: parseInlineMarkdown(source).revision });
  expect(marked).toBe('Before ==*Ada Lovelace*== after.');
  expect(setInlineHighlightType(marked, parseInlineMarkdown(marked).highlights[0].id, person)).toContain('==🟡[*Ada Lovelace*](<Nodes/Ada Lovelace>)==');
});
it.each(['../Ada', 'Ada/Smith', 'Ada#Part', 'Ada|B', 'Ada.md', 'CON', 'Ada.', ' Ada', 'Ada  Smith', 'Ada\\Smith', 'A%20B', 'e\u0301', 'Ada\u200b', 'A:B'])('rejects unsafe or ambiguous filename %s', text => {
  expect(() => typedNodeTarget(text)).toThrow('unsafe or ambiguous');
});
it('validates additive settings lists, reserved Reader types and colors', () => {
  expect(validateHighlightTypes(DEFAULT_SETTINGS.typedHighlightTypes)).toEqual(DEFAULT_SETTINGS.typedHighlightTypes);
  expect(validateHighlightTypes([])).toEqual([]);
  for (const value of [null, {}, [{ name: 'article', color: '🟡' }], [person, person], [{ name: 'person', color: 'pink' }]])
    expect(() => validateHighlightTypes(value)).toThrow();
});
it('creates exact frontmatter-only normal node and reuses it', async () => {
  const store = new MemoryStore();
  await store.create(path, initial);
  const repository = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repository.getArticle(path);
  const saved = await repository.setHighlightType(path, article.highlights[0].id, person);
  expect(await store.read(node)).toBe('---\ntype: person\n---\n');
  expect(saved.body).toBe('Before ==🟡[[Nodes/Ada Lovelace|Ada Lovelace]]== after.\n');
  expect(await store.read(path)).toContain('custom: keep');
  expect(await store.read(path)).toContain('reading_position: "Ada Lovelace"');
  expect((await repository.listArticles()).map(article => article.path)).not.toContain(node);
  await store.process(node, content => content + '\nAuthored body.\n');
  await repository.setHighlightType(path, saved.highlights[0].id, person);
  expect(await store.read(node)).toBe('---\ntype: person\n---\n\nAuthored body.\n');
});
it('keeps an unreferenced empty node after unlinking its highlight', async () => {
  const store = new MemoryStore({ [path]: initial });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const typed = await repo.setHighlightType(path, (await repo.getArticle(path)).highlights[0].id, person);
  const originalNode = await store.read(node);
  await repo.deleteHighlight(path, typed.highlights[0].id);
  expect(await store.read(node)).toBe(originalNode);
  expect((await repo.getArticle(path)).body).toBe('Before Ada Lovelace after.\n');
});
it.each(['another link', 'authored node', 'empty authored node'])('keeps a shared or authored node: %s', async reason => {
  const store = new MemoryStore({ [path]: initial, ...(reason === 'empty authored node' ? { [node]: '---\ntype: person\n---\n' } : {}) }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const typed = await repo.setHighlightType(path, (await repo.getArticle(path)).highlights[0].id, person);
  if (reason === 'another link') await store.create('Other.md', 'A [[Ada Lovelace]] reference.');
  else if (reason === 'authored node') await store.process(node, raw => raw + '\nMy notes.\n');
  const originalNode = await store.read(node);
  await repo.deleteHighlight(path, typed.highlights[0].id);
  expect(await store.read(node)).toBe(originalNode);
  expect((await repo.getArticle(path)).body).toBe('Before Ada Lovelace after.\n');
});
it('keeps the node if another article links to it via a bare wikilink', async () => {
  const store = new MemoryStore({ [path]: initial, 'Other.md': 'Nothing yet.' }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const typed = await repo.setHighlightType(path, (await repo.getArticle(path)).highlights[0].id, person);
  await store.process('Other.md', () => 'See [[Ada Lovelace]].');
  await repo.deleteHighlight(path, typed.highlights[0].id);
  expect(await store.exists(node)).toBe(true);
});
it('colors a highlight linked to an existing typed node, but not an ordinary note', async () => {
  const store = new MemoryStore({ [path]: initial, [node]: '---\ntype: person\n---\nAuthored content.\n', 'Nodes/Other.md': '---\ntype: unknown\n---\n' });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  let article = await repo.getArticle(path);
  article = await repo.setHighlightLink(path, article.highlights[0].id, 'Nodes/Ada Lovelace');
  expect(article.body).toContain('==🟡[[Nodes/Ada Lovelace|Ada Lovelace]]==');
  expect(article.highlights[0]).toMatchObject({ color: '🟡', link: 'Nodes/Ada Lovelace' });
  await repo.deleteHighlight(path, article.highlights[0].id);
  expect(await store.read(node)).toContain('Authored content.');
  const original = await store.read(path);
  const raw = '---\ntype: article\n---\n==Ada Lovelace==';
  await store.process(path, () => raw);
  const plain = await repo.setHighlightLink(path, (await repo.getArticle(path)).highlights[0].id, 'Nodes/Other');
  expect(plain.body).toBe('[[Nodes/Other|Ada Lovelace]]');
  expect(await store.read(node)).toContain('Authored content.');
  expect(original).not.toContain('[[Nodes/');
});
it('colors and unlinks an existing typed note outside Nodes without deleting authored content', async () => {
  const personPath = 'People/Ada.md';
  const store = new MemoryStore({ [path]: initial, [personPath]: '---\ntype: person\n---\nAuthored biography.\n' });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const linked = await repo.setHighlightLink(path, (await repo.getArticle(path)).highlights[0].id, 'People/Ada');
  expect(linked.highlights[0]).toMatchObject({ color: '🟡', link: 'People/Ada' });
  await repo.deleteHighlight(path, linked.highlights[0].id);
  expect((await repo.getArticle(path)).body).toBe('Before Ada Lovelace after.\n');
  expect(await store.read(personPath)).toContain('Authored biography.');
});
it.each(['true', 'false', 'null'])('stores YAML-sensitive type name %s as a string', async name => {
  const type = { name, color: '🟡' } as const, store = new MemoryStore({ [path]: initial });
  const repository = new ReaderRepository(store, { ...DEFAULT_SETTINGS, typedHighlightTypes: [type] });
  const article = await repository.getArticle(path);
  const next = await repository.setHighlightType(path, article.highlights[0].id, type);
  await repository.setHighlightType(path, next.highlights[0].id, type);
  expect(await store.read(node)).toBe(`---\ntype: "${name}"\n---\n`);
});
it.each(['---\ntype: topic\n---\n', '---\ntype: article\n---\n', 'body', '---\ntype: person\ntype: topic\n---\n'])('blocks incompatible or malformed existing nodes without overwrite', async content => {
  const store = new MemoryStore({ [path]: initial, [node]: content }), repository = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repository.getArticle(path);
  await expect(repository.setHighlightType(path, article.highlights[0].id, person)).rejects.toThrow();
  expect(await store.read(path)).toBe(initial); expect(await store.read(node)).toBe(content);
});
it.each(['Nodes/ada lovelace.md', 'nodes/Other.md', 'Nodes'])('blocks ambiguous path %s', async collision => {
  const store = new MemoryStore({ [path]: initial, [collision]: 'keep' }), repository = new ReaderRepository(store, DEFAULT_SETTINGS);
  await expect(repository.setHighlightType(path, (await repository.getArticle(path)).highlights[0].id, person)).rejects.toThrow('ambiguous');
  expect(await store.exists(node)).toBe(false); expect(await store.read(path)).toBe(initial);
});
it('checks stale/current source before node creation', async () => {
  const store = new MemoryStore({ [path]: initial }), repository = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repository.getArticle(path);
  const inspect = vi.fn(async (_path: string, read: (current: string) => void) => read(initial.replace('==Ada', '==Changed')));
  Object.assign(store, { inspect });
  await expect(repository.setHighlightType(path, article.highlights[0].id, person)).rejects.toThrow();
  expect(inspect).toHaveBeenCalled(); expect(await store.exists(node)).toBe(false);
});
it('keeps a created node and reports partial failure when source changes during node creation', async () => {
  const store = new MemoryStore({ [path]: initial }), repository = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repository.getArticle(path), create = store.create.bind(store);
  vi.spyOn(store, 'create').mockImplementation(async (target, content, options) => {
    await create(target, content, options); await store.process(path, raw => raw + 'User edit');
  });
  await expect(repository.setHighlightType(path, article.highlights[0].id, person)).rejects.toThrow('node was kept');
  expect(await store.read(node)).toBe('---\ntype: person\n---\n');
  expect(await store.read(path)).toBe(initial + 'User edit');
});
it('does not overwrite a node created concurrently after the absence check', async () => {
  const store = new MemoryStore({ [path]: initial }), repository = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repository.getArticle(path), create = store.create.bind(store);
  vi.spyOn(store, 'create').mockImplementation(async (target, content, options) => {
    await create(target, '---\ntype: topic\n---\nKeep'); return create(target, content, options);
  });
  await expect(repository.setHighlightType(path, article.highlights[0].id, person)).rejects.toThrow();
  expect(await store.read(node)).toBe('---\ntype: topic\n---\nKeep'); expect(await store.read(path)).toBe(initial);
});
it('guards typed actions waiting on editor eligibility against article lifecycle changes', async () => {
  let generation = 0, release!: () => void;
  const setHighlightType = vi.fn(), repository = { articleGeneration: () => generation, setHighlightType } as unknown as ReaderRepository;
  const controller = new ReaderController(repository, vi.fn(), DEFAULT_SETTINGS, () => new Promise<void>(resolve => { release = resolve; }));
  const pending = controller.typeHighlight(path, 'id', person); await Promise.resolve(); generation++; release();
  await expect(pending).rejects.toThrow(); expect(setHighlightType).not.toHaveBeenCalled(); await controller.shutdown();
});
it('offers type choices directly on existing highlights, including colored node links', async () => {
  const store = new MemoryStore({ [path]: initial }), repository = new ReaderRepository(store, DEFAULT_SETTINGS);
  const controller = new ReaderController(repository, vi.fn(), DEFAULT_SETTINGS), root = document.createElement('div');
  document.body.append(root);
  const stop = mountReader(root, await repository.getArticle(path), controller, { openNote: vi.fn() }, () => {});
  try {
    document.getSelection()?.removeAllRanges();
    root.querySelector('mark')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const personButton = [...root.querySelectorAll('button')].find(button => button.textContent === '🟡 person');
    expect(personButton).toBeDefined(); personButton!.click();
    await vi.waitFor(() => expect(root.querySelector('mark a')?.textContent).toBe('Ada Lovelace'));
    root.querySelector('mark a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(root.querySelector('[aria-label="Highlight actions"]')).not.toBeNull();
    const labels = [...root.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).toContain('Open node'); expect(labels).not.toContain('Link'); expect(labels).not.toContain('Link to…');
    expect([...root.querySelectorAll('button')].some(button => button.textContent === '🔵 location')).toBe(true);
  } finally { await stop(); root.remove(); await controller.shutdown(); }
});
