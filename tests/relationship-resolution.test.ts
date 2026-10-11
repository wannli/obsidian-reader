import { afterEach, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { ReaderController } from '../src/controller';
import { RelationshipDraft } from '../src/ui/relationship-draft';
import { DEFAULT_SETTINGS } from '../src/types';
import { nativeStore } from './helpers/native-store';
const path = 'Reading/Inbox/Resolution.md';
const controllers: ReaderController[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.shutdown(); vi.restoreAllMocks(); });
const source = (property: string) => `---\ntype: article\n${property}: ["[[Ada]]"]\ncustom: keep\n---\nUnchanged body.`;
const resolutionFence = /links resolve differently/;
const node = (property: string) => `---\ntype: ${property === 'authors' ? 'person' : 'topic'}\n---\n`;
function controller(repository: ReaderRepository) { const result = new ReaderController(repository, vi.fn(), DEFAULT_SETTINGS); controllers.push(result); return result; }
for (const property of ['authors', 'topics'] as const) {
  it(`${property} removal rejects a new root note shadowing the displayed target`, async () => {
    const store = new MemoryStore();
    await store.create(path, source(property)); await store.create('People/Ada.md', node(property));
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS), draft = await RelationshipDraft.load(controller(repo), path, property);
    expect([...draft.initial]).toEqual(['People/Ada.md']); draft.selected.delete('People/Ada.md');
    await store.create('Ada.md', node(property));
    await expect(draft.save()).rejects.toThrow('links resolve differently');
    expect(await store.read(path)).toBe(source(property)); expect(await store.read('Ada.md')).toBe(node(property));
  });
  it(`${property} rejects changed resolution before creating any staged nodes`, async () => {
    const store = new MemoryStore({ [path]: source(property), 'People/Ada.md': node(property) });
    const draft = await RelationshipDraft.load(controller(new ReaderRepository(store, DEFAULT_SETTINGS)), path, property);
    draft.selected.delete('People/Ada.md'); draft.stage('Grace'); await store.create('Ada.md', node(property));
    await expect(draft.save()).rejects.toThrow('links resolve differently');
    expect(await store.exists('Nodes/Grace.md')).toBe(false); expect(await store.read(path)).toBe(source(property));
  });
  it(`${property} guards the live native index at the article mutation boundary`, async () => {
    const f = nativeStore({ [path]: source(property), 'People/Ada.md': node(property) });
    const draft = await RelationshipDraft.load(controller(new ReaderRepository(f.store, DEFAULT_SETTINGS)), path, property);
    draft.selected.delete('People/Ada.md'); let processes = 0;
    f.hooks.beforeProcess = async file => {
      if (file.path !== path || ++processes < 2) return;
      f.hooks.beforeProcess = undefined; await f.vault.create('Ada.md', node(property));
    };
    await expect(draft.save()).rejects.toThrow(resolutionFence);
    expect(f.disk.get(path)).toBe(source(property)); expect(f.events.some(event => event.path === path)).toBe(false);
  });
  it.each(['ambiguous', 'renamed', 'unchanged selection'])(`${property} draft rejects a changed target: %s`, async change => {
    const store = new MemoryStore({ [path]: source(property), 'People/Ada.md': node(property) });
    const draft = await RelationshipDraft.load(controller(new ReaderRepository(store, DEFAULT_SETTINGS)), path, property);
    if (change !== 'unchanged selection') draft.selected.delete('People/Ada.md');
    if (change === 'renamed') await store.rename('People/Ada.md', 'People/Renamed.md', { expectedContent: node(property) });
    else await store.create(change === 'ambiguous' ? 'Others/Ada.md' : 'Ada.md', node(property));
    await expect(draft.save()).rejects.toThrow('links resolve differently'); expect(await store.read(path)).toBe(source(property));
  });
  it(`${property} does not reject unrelated topology changes and actually removes the intended reference`, async () => {
    const store = new MemoryStore({ [path]: source(property), 'People/Ada.md': node(property) });
    const draft = await RelationshipDraft.load(controller(new ReaderRepository(store, DEFAULT_SETTINGS)), path, property);
    draft.selected.delete('People/Ada.md'); await store.create('Unrelated.md', 'Ordinary note'); await draft.save();
    expect(await store.read(path)).toBe(source(property).replace(`${property}: ["[[Ada]]"]\n`, ''));
  });
  it(`${property} refuses staged creation that would itself make an existing bare link ambiguous`, async () => {
    const store = new MemoryStore({ [path]: source(property), 'People/Ada.md': node(property) });
    const draft = await RelationshipDraft.load(controller(new ReaderRepository(store, DEFAULT_SETTINGS)), path, property);
    draft.stage('Ada'); await expect(draft.save()).rejects.toThrow('links resolve differently');
    expect(await store.exists('Nodes/Ada.md')).toBe(false); expect(await store.read(path)).toBe(source(property));
  });
  it(`${property} reports a possible saved assignment when retained references change resolution during native save`, async () => {
    const f = nativeStore({ [path]: source(property), 'People/Ada.md': node(property) });
    const draft = await RelationshipDraft.load(controller(new ReaderRepository(f.store, DEFAULT_SETTINGS)), path, property);
    draft.stage('Grace'); const editor = f.open(path);
    editor.view.gateSave = async () => { await f.vault.create('Ada.md', node(property)); };
    await expect(draft.save()).rejects.toThrow('Assignments may already be saved');
    expect(f.disk.get(path)).toContain('[[Nodes/Grace]]'); expect(f.disk.get('Ada.md')).toBe(node(property));
  });
}
