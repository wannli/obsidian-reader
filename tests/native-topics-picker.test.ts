import { afterEach, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { ReaderController } from '../src/controller';
import { DEFAULT_SETTINGS } from '../src/types';
import { RelationshipDraft } from '../src/ui/relationship-draft';
import { relationshipPicker } from '../src/ui/relationship-picker';
import { parseNote } from '../src/storage/markdown';
function element() {
  const root = document.createElement('div');
  return Object.assign(root, { empty: () => root.replaceChildren(), setText: (text: string) => { root.textContent = text; },
    createEl: (tag: string, options: { text: string }) => { const child = document.createElement(tag); child.textContent = options.text; root.append(child); return child; } });
}
class Modal {
  contentEl = element();
  constructor() { document.body.append(this.contentEl); }
  setTitle = vi.fn();
  close() { (this as unknown as { onClose(): void }).onClose(); this.contentEl.remove(); }
}
const Notice = vi.fn(), exports: Record<string, any> = {};
const compiled = ts.transpileModule(readFileSync('src/ui/native-topics.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
new Function('require', 'exports', compiled.outputText)((name: string) => ({ obsidian: { Modal, Notice }, './relationship-draft': { RelationshipDraft }, './relationship-picker': { relationshipPicker } } as Record<string, unknown>)[name], exports);
const ReaderTopics = exports.ReaderTopics as typeof import('../src/ui/native-topics').ReaderTopics;
const path = 'Reading/Inbox/Story.md', body = '\n## Article\n\n==Source words==.\n\n## Comments\n\nMine.\n';
const controllers: ReaderController[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.shutdown(); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function fixture(property: 'topics' | 'authors' = 'topics', current = () => true) {
  const type = property === 'authors' ? 'person' : 'topic';
  const store = new MemoryStore({ [path]: `---\ntype: article\ncustom: keep\nauthor: Legacy untouched\n${property}: ["[[One/Shared]]", "[[Gone/Stale]]"]\n---\n` + body,
    'One/Shared.md': `---\ntype: ${type}\n---\nKeep body.`, 'Two/Shared.md': `---\ntype: ${type}\n---\n`, 'Other/Unique.md': `---\ntype: ${type}\n---\n` });
  const repository = new ReaderRepository(store, DEFAULT_SETTINGS), controller = new ReaderController(repository, vi.fn(), DEFAULT_SETTINGS); controllers.push(controller);
  const modal = new ReaderTopics({} as App, controller, path, property, current), finished = vi.fn(); modal.finished = finished;
  await modal.onOpen(); return { modal, store, repository, controller, finished };
}
function button(modal: InstanceType<typeof ReaderTopics>, text: string) { return [...modal.contentEl.querySelectorAll('button')].find(button => button.textContent === text)!; }
function input(modal: InstanceType<typeof ReaderTopics>, label: string, value: string) { const control = modal.contentEl.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; control.value = value; control.dispatchEvent(new Event('input')); }
function toggle(modal: InstanceType<typeof ReaderTopics>, path: string, checked: boolean) { const control = modal.contentEl.querySelector<HTMLInputElement>(`[aria-label="${path}"]`)!; control.checked = checked; control.dispatchEvent(new Event('change')); }
const rows = (modal: InstanceType<typeof ReaderTopics>) => [...modal.contentEl.querySelectorAll('.r2-relationship-option')];
it.each(['topics', 'authors'] as const)('%s picker preselects full paths, searches and retains unavailable references', async property => {
  const { modal } = await fixture(property);
  expect(rows(modal)).toHaveLength(4);
  expect(modal.contentEl.querySelector<HTMLInputElement>('[aria-label="One/Shared.md"]')!.checked).toBe(true);
  input(modal, 'Search ' + property, 'TWO/'); expect(rows(modal)).toHaveLength(1); expect(rows(modal)[0].textContent).toContain('Two/Shared.md');
  input(modal, 'Search ' + property, 'no match'); expect(rows(modal)).toHaveLength(0);
  input(modal, 'Search ' + property, ''); expect(rows(modal)).toHaveLength(4);
});
it.each(['topics', 'authors'] as const)('%s Save applies multiselect and staged creation without changing body or legacy fields', async property => {
  const { modal, store, finished } = await fixture(property), before = store.snapshot();
  toggle(modal, 'One/Shared.md', false); toggle(modal, 'Two/Shared.md', true);
  const singular = property === 'authors' ? 'author' : 'topic';
  input(modal, `New ${singular} name`, 'Ada Lovelace'); button(modal, `Create ${singular}`).click();
  expect(store.snapshot()).toEqual(before); expect(modal.contentEl.textContent).toContain('create on Save');
  button(modal, 'Save').click(); await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
  const note = parseNote(await store.read(path));
  expect(note.doc.toJS()[property]).toEqual(['[[Gone/Stale]]', '[[Two/Shared]]', '[[Nodes/Ada Lovelace]]']);
  expect(note.body).toBe(body); expect(note.doc.get('author')).toBe('Legacy untouched'); expect(note.doc.get('custom')).toBe('keep');
  expect(await store.read('Nodes/Ada Lovelace.md')).toBe(`---\ntype: ${property === 'authors' ? 'person' : 'topic'}\n---\n`);
  for (const [key, value] of Object.entries(before)) if (key !== path) expect(await store.read(key)).toBe(value);
});
it.each(['Cancel', 'Escape lifecycle'])('%s discards selection and staged creations byte-for-byte', async reason => {
  const { modal, store, finished } = await fixture('authors'), before = store.snapshot();
  toggle(modal, 'One/Shared.md', false); input(modal, 'New author name', 'Charles Babbage'); button(modal, 'Create author').click();
  if (reason === 'Cancel') button(modal, 'Cancel').click(); else modal.close();
  expect(store.snapshot()).toEqual(before); expect(finished).toHaveBeenCalledOnce(); expect(modal.contentEl.isConnected).toBe(false);
});
it('rejects unsafe staged names visibly without writing', async () => {
  const { modal, store } = await fixture(), before = store.snapshot();
  input(modal, 'New topic name', '../unsafe'); button(modal, 'Create topic').click();
  expect(modal.contentEl.querySelector('[role=alert]')?.textContent).toContain('unsafe or ambiguous'); expect(store.snapshot()).toEqual(before);
});
it('deselecting a staged creation prevents its creation on Save', async () => {
  const { modal, store, finished } = await fixture(); input(modal, 'New topic name', 'Do not create'); button(modal, 'Create topic').click();
  toggle(modal, 'Nodes/Do not create.md', false); button(modal, 'Save').click(); await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
  expect(await store.exists('Nodes/Do not create.md')).toBe(false);
});
it('does not save a draft after navigation and keeps the visible error', async () => {
  let current = true; const { modal, store } = await fixture('authors', () => current), before = store.snapshot();
  input(modal, 'New author name', 'Someone'); button(modal, 'Create author').click(); current = false; button(modal, 'Save').click();
  await vi.waitFor(() => expect(modal.contentEl.querySelector('[role=alert]')?.textContent).toContain('Article changed'));
  expect(store.snapshot()).toEqual(before); button(modal, 'Cancel').click();
});
it('disables editing, duplicate saves and user close while confirmed saving is pending', async () => {
  const { modal, controller, finished } = await fixture(); let resolve!: () => void;
  const assign = vi.spyOn(controller, 'assignTopics').mockImplementation(() => new Promise<any>(done => { resolve = () => done({}); }));
  toggle(modal, 'Two/Shared.md', true); const save = button(modal, 'Save'); save.click(); save.click(); modal.close();
  expect(assign).toHaveBeenCalledOnce(); expect(finished).not.toHaveBeenCalled(); expect(save.disabled).toBe(true);
  expect([...modal.contentEl.querySelectorAll<HTMLInputElement>('input')].every(input => input.disabled)).toBe(true);
  resolve(); await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
});
it('closing while loading never repopulates or writes', async () => {
  const store = new MemoryStore({ [path]: '---\ntype: article\n---\nBody' }), repository = new ReaderRepository(store, DEFAULT_SETTINGS);
  const controller = new ReaderController(repository, vi.fn(), DEFAULT_SETTINGS); controllers.push(controller);
  let resolve!: (value: []) => void; vi.spyOn(repository, 'listTopics').mockReturnValue(new Promise(done => { resolve = done; }));
  const modal = new ReaderTopics({} as App, controller, path), before = store.snapshot();
  const opening = modal.onOpen(); modal.close(); resolve([]); await opening;
  expect(modal.contentEl.childElementCount).toBe(0); expect(store.snapshot()).toEqual(before);
});
it('failure keeps the draft for retry or cancellation', async () => {
  const { modal, controller, store } = await fixture(), before = store.snapshot();
  vi.spyOn(controller, 'assignTopics').mockRejectedValue(new Error('Read-only note')); toggle(modal, 'Two/Shared.md', true); button(modal, 'Save').click();
  await vi.waitFor(() => expect(modal.contentEl.querySelector('[role=alert]')?.textContent).toBe('Read-only note'));
  expect(button(modal, 'Save').disabled).toBe(false); expect(store.snapshot()).toEqual(before); button(modal, 'Cancel').click();
});
