import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { validateHighlightTypes } from '../src/typed-highlights';
import { ReaderApp } from '../src/ui/app';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { parseNote } from '../src/storage/markdown';
import { DEFAULT_SETTINGS, type Article } from '../src/types';
import { validReadingPosition as readingPosition, type ReadingPosition } from '../src/reading-position';
import { nativeDeleteHandler } from '../src/native-delete';
import * as einkDevice from '../src/eink-device';
import { mountReader } from '../src/ui/reader';
const tracking = vi.hoisted(() => ({ position: { marker: '' } as ReadingPosition }));
vi.mock('../src/ui/scroll-position', () => ({ trackScrollPosition: () => ({ getPosition: () => tracking.position, restorePosition: (value: ReadingPosition) => { tracking.position = value; }, dispose() {} }) }));
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });
function load(path: string, dependencies: Record<string, unknown>) {
  const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  new Function('require', 'exports', output)((name: string) => { if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name); return dependencies[name]; }, exports); return exports;
}
async function nativeFixture() {
  tracking.position = { marker: '' };
  const store = new MemoryStore(), settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(store, settings);
  const article = await repo.createArticle({ title: 'A', url: '', body: 'one two three', status: 'inbox' });
  const factories = new Map<string, (leaf: any) => any>(), events = new Map<string, Function>(), notices: string[] = [], timers: number[] = [], leaves: any[] = [];
  class TFile { extension = 'md'; basename = 'A'; constructor(public path: string) {} }
  const file = new TFile(article.path);
  class FileView {
    app: any; file: any = null; titleEl = document.createElement('div'); contentEl: any;
    constructor(public leaf: any) { this.app = leaf.app; const node = document.createElement('div'); this.contentEl = Object.assign(node, { addClass: (name: string) => node.classList.add(name) }); document.body.append(node); }
    async setState(state: any) { this.file = state.file ? this.app.vault.getFileByPath(state.file) : null; }
    async onClose() {} async onRename() {} onPaneMenu() {}
  }
  class Plugin {
    constructor(public app: any) {} async loadData() { return {}; } async saveData() {}
    registerView(type: string, factory: any) { factories.set(type, factory); }
    addCommand() {} addRibbonIcon() {} addSettingTab() {} register() {} registerEvent() {} registerDomEvent() {}
    registerInterval(timer: number) { timers.push(timer); }
  }
  class NativeReaderUI { dispose() {} }
  const sdk = { Plugin, FileView, TFile, Platform: { isMobile: false, isAndroidApp: false }, setIcon() {}, Notice: class { constructor(message: string) { notices.push(message); } }, parseLinktext: (target: string) => ({ path: target, subpath: '' }) };
  const PluginClass = load('src/main.ts', {
    obsidian: sdk, './native-delete': { nativeDeleteHandler }, './reading-position': { validReadingPosition: readingPosition }, './eink-device': einkDevice,
    './typed-highlights': { validateHighlightTypes }, './types': { DEFAULT_SETTINGS }, './storage/repository': { ReaderRepository: class { constructor() { return repo; } } },
    './obsidian-store': { ObsidianStore: class {} }, './controller': { ReaderController }, './transport': { obsidianGet: vi.fn() }, './ui/app': { ReaderApp },
    './settings': { ReaderSettingsTab: class {} }, './routing': { installArticleRouting: () => ({ dispose() {}, remapPath() {} }) },
    './ui/native': { NativeReaderUI }, './ui/native-popups': { nativeHighlightMenu: vi.fn(), nativeLinkMenu: vi.fn() },
    './template-exclusions': { readTemplateExclusions: async () => ({ folders: [], files: [] }) }, './storage/classifier': { isArticleTemplatePath: () => false },
    './settings-migration': { settingsData: async (current: unknown) => ({ data: current as Record<string, unknown>, migrated: false }) },
  }).default;
  const app: any = { vault: { on: (name: string, fn: Function) => { events.set(name, fn); }, getFileByPath: (path: string) => path === file.path ? file : null, getMarkdownFiles: () => [file] } };
  app.workspace = { activeLeaf: null, getLeavesOfType: (type: string) => leaves.filter(leaf => leaf.view.getViewType() === type), iterateAllLeaves: (fn: Function) => leaves.forEach(leaf => fn(leaf)), requestSaveLayout() {}, onLayoutReady() {}, on() {}, offref() {}, getLeaf: () => leaves[0] };
  const plugin = new PluginClass(app); await plugin.onload(); plugin.controller.setOnline(false);
  const leaf: any = { app, updateHeader() {}, async setViewState(state: any) { if (state.type !== 'reader') { this.view = { getViewType: () => state.type }; return; } this.view = factories.get('reader')!(this); await this.view.onOpen(); await this.view.setState(state.state ?? {}, {}); } };
  leaves.push(leaf); app.workspace.activeLeaf = leaf;
  await leaf.setViewState({ type: 'reader', state: { file: article.path } });
  cleanup.push(async () => { timers.forEach(timer => window.clearInterval(timer)); plugin.onunload(); await app[Symbol.for('reader.shutdown')]; });
  return { store, repo, article, plugin, leaf, file, events, notices };
}
it.each(['none', 'close', 'unload'])('production native rename retains an unsaved position at the destination (immediate action: %s)', async action => {
  const f = await nativeFixture(), destination = 'Reading/Later/A.md';
  const before = parseNote(await f.store.read(f.article.path));
  tracking.position = { marker: 'two three' };
  const expected = { ...tracking.position };
  await f.store.rename(f.article.path, destination, { expectedContent: await f.store.read(f.article.path) }); f.file.path = destination;
  f.events.get('rename')!(f.file, f.article.path);
  if (action === 'unload') f.plugin.onunload();
  const closing = action === 'close' ? f.leaf.view.onClose() : action === 'unload' ? f.plugin.app[Symbol.for('reader.shutdown')] : Promise.resolve();
  await Promise.all([closing, ...(f.plugin as any).nativeRenames]);
  if (action === 'none') await f.leaf.view.getReader().flushPosition();
  const after = parseNote(await f.store.read(destination));
  expect(after.body).toBe(before.body);
  const yaml = after.doc.toJS(); delete yaml.reading_position;
  expect(yaml).toEqual(before.doc.toJS());
  expect(after.doc.toJS().reading_position).toEqual(expected.marker);
  expect(f.notices).toEqual([]);
});
it('production unload barrier drains an actual delayed repository position write', async () => {
  const f = await nativeFixture();
  const original = f.repo.saveReadingPositionRevision.bind(f.repo); let release!: () => void;
  vi.spyOn(f.repo, 'saveReadingPositionRevision').mockImplementationOnce(async (...args) => { await new Promise<void>(done => { release = done; }); return original(...args); });
  tracking.position = { marker: 'two' }; const expected = { ...tracking.position };
  f.plugin.onunload(); let completed = false;
  const barrier = f.plugin.app[Symbol.for('reader.shutdown')].then(() => { completed = true; });
  await Promise.resolve(); expect(completed).toBe(false); release(); await barrier;
  expect(parseNote(await f.store.read(f.article.path)).doc.toJS().reading_position).toEqual(expected.marker);
  expect(f.notices).toEqual([]);
});
it('pre-move position flush survives adjacent queue navigation without resurrecting the moved article', async () => {
  const f = await nativeFixture(), reader = f.leaf.view.getReader();
  const original = f.repo.saveReadingPositionRevision.bind(f.repo); let release!: () => void;
  vi.spyOn(f.repo, 'saveReadingPositionRevision').mockImplementationOnce(async (...args) => { await new Promise<void>(done => { release = done; }); return original(...args); });
  tracking.position = { marker: 'two' }; const expected = { ...tracking.position };
  const moving = reader.move('later'); await Promise.resolve(); await reader.navigateQueue(1);
  const queue = reader.getState().queue;
  release(); await moving;
  expect(reader.getState().queue).toBe(queue); expect(reader.getArticle()).toBeUndefined();
  const moved = await f.repo.getArticle('Reading/Later/' + f.article.path.split('/').at(-1));
  expect(moved.status).toBe('later'); expect(moved.readingPosition).toEqual(expected);
});
it('retains captured positions through real Reader autosave without remounting the selected DOM', async () => {
  vi.useFakeTimers(); const f = await nativeFixture(), reader = f.leaf.view.getReader();
  const original = f.repo.saveReadingPositionRevision.bind(f.repo); let release!: () => void;
  const saves = vi.spyOn(f.repo, 'saveReadingPositionRevision').mockImplementationOnce(async (...args) => { await new Promise<void>(done => { release = done; }); return original(...args); });
  tracking.position = { marker: 'two' }; const first = reader.flushPosition(); await Promise.resolve();
  tracking.position = { marker: 'three' }; const queued = reader.flushPosition();
  const text = f.leaf.view.contentEl.querySelector('.r2-article-body p')!.firstChild!, range = document.createRange();
  range.setStart(text, 0); range.setEnd(text, 3); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange'));
  try {
    await vi.advanceTimersByTimeAsync(1000); expect((await f.repo.getArticle(f.article.path)).body).toBe('==one== two three');
    expect(document.getSelection()!.getRangeAt(0)).toBe(range);
  } finally { release(); await Promise.all([first, queued]); }
  expect(saves).toHaveBeenCalledTimes(2); expect((await f.repo.getArticle(f.article.path)).readingPosition).toEqual({ marker: 'three' });
});
it.each(['completely changed text', '**one** two three'])('does not dispatch a queued old-body position after external DOM refresh: %s', async replacement => {
  tracking.position = { marker: '' };
  const article: Article = { path: 'Reading/Inbox/A.md', id: '', title: 'A', url: '', status: 'inbox', content: 'ready', extractor: 'manual', body: 'one two three', highlights: [] };
  let release!: () => void;
  const save = vi.fn(async () => ''); save.mockImplementationOnce(async () => { await new Promise<void>(done => { release = done; }); return ''; });
  const controller = { repository: { articleGeneration: () => 0, saveReadingPosition: save } } as unknown as ReaderController;
  const root = document.createElement('div'); document.body.append(root);
  const mount = mountReader(root, article, controller, { openNote() {}, notify() {} }, () => {}); cleanup.push(() => mount());
  tracking.position = { marker: 'two' }; const first = mount.flushPosition!(); await Promise.resolve();
  tracking.position = { marker: 'three' }; const queued = mount.flushPosition!();
  const text = root.querySelector('.r2-article-body p')!.firstChild!, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 3); document.getSelection()!.addRange(range);
  mount.update!({ ...article, body: replacement });
  document.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
  release(); await Promise.all([first, queued]);
  expect(save.mock.calls).toEqual([[article.path, { marker: 'two' }, '', 0]]);
});
