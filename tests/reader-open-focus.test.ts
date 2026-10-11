import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DEFAULT_SETTINGS } from '../src/types';
import { validateHighlightTypes } from '../src/typed-highlights';
import { validReadingPosition as readingPosition } from '../src/reading-position';
import { queueLabel } from '../src/reading-layout';
import { readerCommands } from '../src/ui/commands';
import { nativeDeleteHandler } from '../src/native-delete';
import * as einkDevice from '../src/eink-device';
// SDK contract fixture: revealLeaf deliberately neither activates nor focuses.
// Native Obsidian acceptance remains a separate tooling-owned check.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); document.body.replaceChildren(); });
function load(path: string, dependencies: Record<string, unknown>) {
  const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {}; new Function('require', 'exports', output)((name: string) => { if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name); return dependencies[name]; }, exports); return exports;
}
async function fixture(existing: boolean, savedData?: Record<string, unknown>) {
  const factories = new Map<string, (leaf: any) => any>(), commands = new Map<string, any>(), timers: number[] = [];
  let ribbon!: () => void, ribbonLabel = '', route!: any;
  class ItemView {
    app: any; titleEl = document.createElement('div'); contentEl: HTMLElement & { addClass(name: string): void };
    constructor(public leaf: any) {
      this.app = leaf.app; const node = document.createElement('div'); this.contentEl = Object.assign(node, { addClass: (name: string) => node.classList.add(name) }); document.body.append(node);
    }
    async setState(_state: any) {} async onClose() {} onPaneMenu() {}
  }
  class FileView extends ItemView {
    file: any = null;
    allowNoFile = false;
    navigation = true;
    fileTransitions = 0;
    async setState(state: any) {
      const file = state.file ? this.app.vault.getFileByPath(state.file) : null;
      if (this.file !== file) { this.file = file; this.fileTransitions++; await Promise.resolve(); this.titleEl.textContent = (this as any).getDisplayText(); }
    }
    async onRename(file: any) { if (file === this.file) this.titleEl.textContent = file.basename; }
  }
  class Plugin {
    constructor(public app: any) {}
    async loadData() { return savedData; }
    saveData = vi.fn(async (_settings: unknown) => {});
    registerView(type: string, factory: (leaf: any) => any) { factories.set(type, factory); }
    addCommand(command: any) { commands.set(command.id, command); }
    addRibbonIcon(_icon: string, label: string, callback: () => void) { ribbon = callback; ribbonLabel = label; }
    addSettingTab() {} register() {} registerEvent() {} registerDomEvent() {}
    registerInterval(timer: number) { timers.push(timer); }
  }
  class ReaderApp {
    state: Record<string, unknown> = {}; loading?: Promise<void>; draining?: Promise<void>; root = document.createElement('div'); heading = document.createElement('h1');
    constructor(target: HTMLElement, _controller: unknown, private host: any) {
      this.root.className = 'r2-app'; this.heading.className = 'r2-article-title'; this.heading.tabIndex = -1; this.heading.textContent = 'Article'; this.root.append(this.heading); target.replaceChildren(this.root);
    }
    getState() { return this.state; }
    getArticle() { return this.state.file ? { path: this.state.file, title: this.heading.textContent } : undefined; }
    setTitle(title: string) { this.heading.textContent = title; this.host.onStateChange?.(); }
    async openDefault() {}
    openLibrary = vi.fn(async () => {});
    remapPosition = vi.fn((from: string, to: string) => { if (this.state.file === from) { this.state = { ...this.state, file: to }; this.host.onStateChange?.(); } });
    remapPath = vi.fn((from: string, to: string) => { if (this.state.file === from) { this.state = { ...this.state, file: to }; this.host.onStateChange?.(); } });
    async open(path: string, options: any = {}) { this.state = { ...options, file: path }; this.host.onStateChange?.(); await this.loading; if (options.focus !== false && this.host.shouldFocus()) this.heading.focus({ preventScroll: true }); this.host.onStateChange?.(); }
    destroy() { this.root.remove(); return this.draining ?? Promise.resolve(); }
  }
  class ReaderController { async shutdown() {} }
  const sdk = { Plugin, ItemView, FileView, Platform: { isMobile: false, isAndroidApp: false }, setIcon: vi.fn(), Menu: class {}, Modal: class {}, Notice: class { hide() {} } };
  const NativeReaderUI = load('src/ui/native.ts', { obsidian: sdk, '../reading-layout': { queueLabel }, './commands': { readerCommands }, './native-dialogs': { ReaderPicker: class {}, ReaderInput: class {}, ReaderFeeds: class {} }, './native-topics': { ReaderTopics: class {} }, './highlight-link-picker': { HighlightLinkPicker: class {} } }).NativeReaderUI;
  const ReaderPlugin = load('src/main.ts', {
    './native-delete': { nativeDeleteHandler }, './reading-position': { validReadingPosition: readingPosition },
    './eink-device': einkDevice,
    obsidian: sdk, './typed-highlights': { validateHighlightTypes }, './types': { DEFAULT_SETTINGS }, './storage/repository': { ReaderRepository: class {} }, './obsidian-store': { ObsidianStore: class {} }, './controller': { ReaderController }, './transport': { obsidianGet: vi.fn() }, './ui/app': { ReaderApp }, './settings': { ReaderSettingsTab: class {} },
    './routing': { installArticleRouting: (options: unknown) => { route = options; return { dispose() {}, preserveMarkdown() { return () => {}; } }; } }, './ui/native': { NativeReaderUI }, './ui/native-popups': { nativeHighlightMenu: vi.fn(), nativeLinkMenu: vi.fn() }, './template-exclusions': { readTemplateExclusions: async () => ({ folders: [], files: [] }) }, './storage/classifier': { isArticleTemplatePath: () => false },
  }).default;
  const files = new Map<string, { path: string; basename: string }>();
  const leaves: any[] = [], app: any = { vault: { on: vi.fn(), getFileByPath: (path: string) => {
    if (!files.has(path)) files.set(path, { path, basename: path.split('/').pop()!.replace(/\.md$/, '') });
    return files.get(path);
  } } };
  function leaf(type = 'markdown') {
    const value: any = { app, updateHeader: vi.fn(), view: { getViewType: () => type }, async setViewState(state: any) {
      if (state.type !== 'reader') { value.view = { getViewType: () => state.type }; return; }
      value.view = factories.get('reader')!(value); await value.view.onOpen(); await value.view.setState(state.state ?? {}, {});
      // Deliberately do not implement activation via state.active either.
    } }; leaves.push(value); return value;
  }
  const markdown = leaf(), editor = document.createElement('textarea'); document.body.append(editor); editor.focus();
  const workspace: any = app.workspace = {
    activeLeaf: markdown, getLeavesOfType: (type: string) => leaves.filter(leaf => leaf.view.getViewType() === type),
    // Native file reuse checks FileView identity, not custom getState().file.
    getLeavesOfFile: (path: string) => leaves.filter(leaf => leaf.view instanceof FileView && leaf.view.file === app.vault.getFileByPath(path)),
    getLeaf: vi.fn(() => leaf('empty')), revealLeaf: vi.fn(async () => {}),
    setActiveLeaf: vi.fn((selected: any, _options: unknown) => { workspace.activeLeaf = selected; }),
    requestSaveLayout: vi.fn(), onLayoutReady: vi.fn(), on: vi.fn(),
  };
  const plugin = new ReaderPlugin(app); await plugin.onload();
  let reader: any;
  if (existing) { reader = leaf(); await reader.setViewState({ type: 'reader', state: { file: 'Reading/Articles/Existing.md' } }); }
  cleanup.push(async () => { timers.forEach(timer => window.clearInterval(timer)); plugin.onunload(); await app[Symbol.for('reader.shutdown')]; });
  return { plugin, workspace, markdown, editor, commands, ribbon, ribbonLabel, route, leaf, getReaderLeaf: () => reader ?? workspace.getLeavesOfType('reader')[0] };
}
it.each([false, true])('native shutdown barrier drains position saves from a %s already-closing/detached Reader', async detach => {
  const f = await fixture(true), leaf = f.getReaderLeaf(), view = leaf.view;
  let release!: () => void; view.getReader().draining = new Promise<void>(done => { release = done; });
  let closed = false, drained = false;
  const closing = detach ? view.onClose().then(() => { closed = true; }) : Promise.resolve();
  if (detach) leaf.view = { getViewType: () => 'markdown' }; // Already absent from getLeavesOfType during unload.
  f.plugin.onunload(); const barrier = f.plugin.app[Symbol.for('reader.shutdown')].then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); if (detach) expect(closed).toBe(false);
  release(); await Promise.all([closing, barrier]); expect(drained).toBe(true); if (detach) expect(closed).toBe(true);
});
it.each([undefined, {}, { dailyFolder: 'Old', dailyFormat: 'YYYY-MM-DD', dailyHeading: 'Reading', logToDailyJournal: true }])('legacy journal settings are ignored while active settings persist: %j', async saved => {
  const { plugin, commands } = await fixture(false, saved);
  expect([...commands.keys()].join(' ')).not.toMatch(/daily|journal|repair/i);
  for (const key of ['dailyFolder', 'dailyFormat', 'dailyHeading', 'logToDailyJournal']) expect(plugin.settings).not.toHaveProperty(key);
  plugin.settings.useDummyContent = false; await plugin.saveSettings();
  expect(plugin.saveData).toHaveBeenCalledWith(plugin.settings);
  for (const key of ['dailyFolder', 'dailyFormat', 'dailyHeading', 'logToDailyJournal']) expect(plugin.saveData.mock.calls.at(-1)?.[0]).not.toHaveProperty(key);
  const reloaded = await fixture(false, { ...plugin.settings });
  expect(reloaded.plugin.settings.useDummyContent).toBe(false);
});
it('persists configured typed-highlight lists additively and accepts an intentionally empty list', async () => {
  const types = [{ name: 'organization', color: '🟠' }, { name: 'event', color: '🔴' }];
  const { plugin } = await fixture(false, { typedHighlightTypes: types, useDummyContent: false });
  expect(plugin.settings.typedHighlightTypes).toEqual(types);
  expect(plugin.settings.useDummyContent).toBe(false);
  await plugin.saveSettings();
  expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({ typedHighlightTypes: types }));
  const empty = await fixture(false, { typedHighlightTypes: [] });
  expect(empty.plugin.settings.typedHighlightTypes).toEqual([]);
});
it.each([null, {}, [{ name: 'article', color: '🟡' }], [{ name: 'person', color: 'invalid' }]])('rejects malformed saved typed-highlight settings: %j', async typedHighlightTypes => {
  const { plugin } = await fixture(false, { typedHighlightTypes });
  expect(plugin.settings.typedHighlightTypes).toEqual(DEFAULT_SETTINGS.typedHighlightTypes);
});
for (const existing of [true, false]) for (const action of ['command', 'ribbon'] as const) {
  it(`explicit ${action} activates and focuses ${existing ? 'existing' : 'new'} Reader when revealLeaf does not`, async () => {
    const f = await fixture(existing);
    await f.workspace.revealLeaf(f.getReaderLeaf() ?? f.markdown); expect(f.workspace.activeLeaf).toBe(f.markdown); expect(document.activeElement).toBe(f.editor); f.workspace.revealLeaf.mockClear();
    if (action === 'command') expect(f.commands.get('open-reader').checkCallback(false)).toBe(true); else f.ribbon();
    await vi.waitFor(() => expect(f.workspace.setActiveLeaf).toHaveBeenCalledTimes(1));
    const target = f.getReaderLeaf(); expect(f.workspace.activeLeaf).toBe(target); expect(f.workspace.setActiveLeaf).toHaveBeenCalledWith(target, { focus: true }); expect(f.workspace.revealLeaf).toHaveBeenCalledWith(target);
    expect(target.view.contentEl.contains(document.activeElement)).toBe(true); expect(document.activeElement?.classList.contains('r2-article-title')).toBe(true);
    expect(f.workspace.getLeaf).toHaveBeenCalledTimes(existing ? 0 : 1);
    if (action === 'ribbon') {
      expect(f.ribbonLabel).toBe('Reading list');
      await vi.waitFor(() => expect(target.view.getReader().openLibrary).toHaveBeenCalledOnce());
    } else expect(target.view.getReader().openLibrary).not.toHaveBeenCalled();
  });
}
it('exposes a native file identity so repeated article opens reuse the viewer', async () => {
  const f = await fixture(false), path = 'Reading/Inbox/261009 Same article.md';
  async function clickArticle() {
    const existing = f.workspace.getLeavesOfFile(path)[0];
    if (existing) return existing;
    const target = f.leaf();
    await f.route.openReaderInLeaf(target, { path, ephemeralState: {}, isCurrent: () => true });
    return target;
  }
  const first = await clickArticle();
  expect(await clickArticle()).toBe(first);
  expect(f.workspace.getLeavesOfType('reader')).toHaveLength(1);
  expect(first.view.fileTransitions).toBe(1);
  expect(first.view.navigation).toBe(true);
  expect(first.view.canAcceptExtension('md')).toBe(false);
  await first.view.getReader().open('Reading/Inbox/Other.md');
  expect(f.workspace.getLeavesOfFile(path)).toHaveLength(0);
  expect(f.workspace.getLeavesOfFile('Reading/Inbox/Other.md')).toEqual([first]);
  expect(first.view.fileTransitions).toBe(2);
});
it.each([false, true])('forwards next-article renames without replacing displayed native/saved identity (stale saved source=%s)', async staleSaved => {
  const f = await fixture(true), view = f.getReaderLeaf().view;
  // Direct Reader navigation leaves the original saved-state seed behind.
  const from = staleSaved ? view.getState().file : 'Reading/Inbox/Next legacy note.md';
  if (staleSaved) await view.getReader().open('Reading/Inbox/Currently displayed.md');
  const before = view.getState(), saved = { ...view.savedState }, file = view.file; f.workspace.requestSaveLayout.mockClear();
  const to = 'Reading/Inbox/Renamed legacy note.md';
  view.remapPosition(from, to); view.remapPath(from, to);
  expect(view.getReader().remapPosition).toHaveBeenCalledWith(from, to);
  expect(view.getReader().remapPath).toHaveBeenCalledWith(from, to);
  expect(view.savedState).toEqual(saved); expect(view.getState()).toEqual(before); expect(view.file).toBe(file);
  expect(f.workspace.requestSaveLayout).not.toHaveBeenCalled();
});
it('recognizes the displayed destination after the synchronous native position handoff', async () => {
  const f = await fixture(true), view = f.getReaderLeaf().view;
  const from = view.getState().file, to = 'Reading/Treasury/Renamed current.md';
  view.remapPosition(from, to);
  expect(view.getState().file).toBe(to); expect(view.file.path).toBe(to);
  f.workspace.requestSaveLayout.mockClear(); view.remapPath(from, to);
  expect(view.getReader().remapPath).toHaveBeenCalledWith(from, to);
  expect(view.getState().file).toBe(to); expect(view.file.path).toBe(to);
  expect(f.workspace.requestSaveLayout).toHaveBeenCalled();
});
it('publishes file identity while article loading is still pending', async () => {
  const f = await fixture(false), target = f.leaf();
  await target.setViewState({ type: 'reader' });
  let finish!: () => void;
  target.view.getReader().loading = new Promise<void>(resolve => { finish = resolve; });
  const path = 'Reading/Inbox/Loading.md';
  const pending = target.view.setState({ file: path }, {});
  expect(f.workspace.getLeavesOfFile(path)).toEqual([target]);
  finish(); await pending;
  expect(f.workspace.getLeavesOfFile(path)).toEqual([target]);
});
it('uses the article title for the native viewer title, with a Reader fallback', async () => {
  const f = await fixture(false), target = f.leaf();
  await target.setViewState({ type: 'reader' });
  expect(target.view.getDisplayText()).toBe('Reader');
  await target.view.getReader().open('Reading/Inbox/261009 Filename.md');
  expect(target.view.getDisplayText()).toBe('Article');
  expect(target.updateHeader).toHaveBeenCalled();
  expect(target.view.titleEl.textContent).toBe('Article');
  target.view.getReader().setTitle('An exact article title — not the filename');
  expect(target.view.getDisplayText()).toBe('An exact article title — not the filename');
  expect(target.view.titleEl.textContent).toBe('An exact article title — not the filename');
  target.view.file.basename = 'Renamed filename';
  await target.view.onRename(target.view.file);
  expect(target.view.titleEl.textContent).toBe('An exact article title — not the filename');
});
it('automatic routing replaces only its intended inactive leaf and never activates or focuses it', async () => {
  const f = await fixture(false), target = f.leaf();
  await f.route.openReaderInLeaf(target, { path: 'Reading/Articles/Automatic.md', ephemeralState: {}, isCurrent: () => true });
  expect(target.view.getViewType()).toBe('reader'); expect(target.view.getState().file).toBe('Reading/Articles/Automatic.md'); expect(f.workspace.activeLeaf).toBe(f.markdown); expect(document.activeElement).toBe(f.editor);
  expect(f.workspace.setActiveLeaf).not.toHaveBeenCalled(); expect(f.workspace.revealLeaf).not.toHaveBeenCalled(); expect(f.workspace.getLeaf).not.toHaveBeenCalled();
});
