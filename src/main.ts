import { nodesApi, NODES_UNAVAILABLE } from './nodes-api';
import { NodePicker } from './ui/node-picker';
import { nativeDeleteHandler } from './native-delete';
import { Plugin, FileView, Notice, Platform, TFile, parseLinktext, type App, type Menu, type TAbstractFile, type WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import { DEFAULT_SETTINGS, type ReaderSettings } from './types';
import { normalizeFeedSchedule } from './feed-schedule';
import { ReaderRepository } from './storage/repository';
import { ObsidianStore } from './obsidian-store';
import { ReaderController } from './controller';
import { obsidianGet } from './transport';
import { ReaderApp } from './ui/app';
import { ReaderSettingsTab } from './settings';
import { installArticleRouting, type ArticleRouting } from './routing';
import type { ReaderState } from './ui/reader-state';
import { validReadingPosition as validateReadingPosition } from './reading-position';
import { einkEnabled, normalizeEinkDevice, readEinkDevice, writeEinkDevice, type EinkDeviceSettings } from './eink-device';
import { NativeReaderUI } from './ui/native';
import { nativeReadingChrome } from './ui/reading-chrome';
import { nativeHighlightMenu, nativeLinkMenu } from './ui/native-popups';
import { readTemplateExclusions } from './template-exclusions';
import { isArticleTemplatePath, type ArticleTemplateExclusions } from './storage/classifier';
const VIEW = 'reader';
const BARRIER = Symbol.for('reader.shutdown');
const RESUME = Symbol.for('reader.view-resume');
/** Open only an existing file object: never delegate to create-capable openLinkText. */
export async function openExistingNote(app: App, target: string, source = ''): Promise<void> {
  if (!target.trim()) throw new Error('The linked note is missing. No note was created.');
  const { path, subpath } = parseLinktext(target);
  const file = path ? app.metadataCache.getFirstLinkpathDest(path, source) : source ? app.vault.getFileByPath(source) : null;
  if (!file) throw new Error('Linked note does not exist: ' + target + '. No note was created.');
  const resolvedPath = file.path;
  const assertCurrent = () => {
    if (file.path !== resolvedPath || app.vault.getFileByPath(resolvedPath) !== file)
      throw new Error('The linked note changed or was deleted. Reopen the link; no note was created.');
  };
  assertCurrent();
  const leaf = app.workspace.getLeaf(true);
  assertCurrent();
  await leaf.openFile(file, { active: true, ...(subpath ? { eState: { subpath } } : {}) });
  assertCurrent();
}
class ReaderView extends FileView {
  private reader?: ReaderApp;
  private chrome?: ReturnType<typeof nativeReadingChrome>;
  private savedState: ReaderState = {};
  private stateRevision = 0;
  private applyingState = false;
  private appliedState = false;
  constructor(leaf: WorkspaceLeaf, private plugin: ReaderPlugin) {
    super(leaf); this.allowNoFile = true; this.savedState = plugin.routeState(leaf) ?? {};
  }
  getViewType() { return VIEW; }
  getDisplayText() { return this.reader?.getArticle()?.title || this.file?.basename || 'Reader'; }
  private refreshTitle() {
    // FileView's breadcrumb label is separate from the leaf's tab title.
    // Both hooks are internal on supported Obsidian versions; keep them scoped
    // to this view and optional rather than changing global native chrome.
    const titleEl = (this as FileView & { titleEl?: HTMLElement }).titleEl;
    if (titleEl) titleEl.textContent = this.getDisplayText();
    (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
  }
  async onRename(file: TFile): Promise<void> { await super.onRename(file); this.refreshTitle(); }
  getIcon() { return 'book-open'; }
  async onOpen() {
    this.contentEl.addClass('r2-view');
    this.chrome = nativeReadingChrome(this.contentEl, () => Platform.isMobile && this.app.workspace.activeLeaf === this.leaf);
    this.reader = new ReaderApp(this.contentEl, this.plugin.controller, {
      openNote: (path, source) => openExistingNote(this.app, path, source),
      openMarkdown: path => this.plugin.openMarkdown(this.leaf, path),
      autoOpen: false, isMobile: Platform.isMobile,
      setChromeHidden: hidden => this.chrome?.setHidden(hidden),
      shouldFocus: () => this.app.workspace.activeLeaf === this.leaf,
      einkEnabled: () => this.plugin.isEinkEnabled(),
      reversePageButtons: () => this.plugin.einkDevice.reverseButtons,
      onEinkChange: callback => this.plugin.subscribeEink(callback),
      onActiveChange: callback => {
        const event = this.app.workspace.on('active-leaf-change', () => callback());
        return () => this.app.workspace.offref(event);
      },
      onStateChange: () => {
        const state = this.reader?.getState();
        if (state && (state.file ?? null) !== (this.file?.path ?? null)) {
          // Let FileView update file events/breadcrumbs as well as identity.
          void super.setState(state, { history: false }).then(() => this.refreshTitle()).catch(error => new Notice(String(error)));
        }
        this.refreshTitle();
        this.app.workspace.requestSaveLayout();
      },
      notify: message => { new Notice(message); },
      confirmTrash: (eligible, skipped) => this.plugin.native?.confirmTrash(eligible, skipped) ?? Promise.resolve(false),
      pickArticle: (articles, queue, choose) => this.plugin.native?.pickArticles(articles, queue, choose),
      nodeForLink: (target, source) => {
        const file = this.app.metadataCache.getFirstLinkpathDest(target, source);
        return file ? nodesApi(this.app)?.getNode(file.path) ?? null : null;
      },
      pickNode: (quote, source, current, choose, finished, preflight) => {
        const api = nodesApi(this.app);
        if (!api) { new Notice(NODES_UNAVAILABLE); finished?.(); return () => {}; }
        let active = true;
        const valid = () => active && current() && nodesApi(this.app) === api;
        const picker = new NodePicker(this.app, quote, source, valid, async node => {
          const guard = () => {
            if (!valid()) throw new Error('Highlight or Nodes changed. Reopen the highlight.');
            const live = api.getNode(node.path);
            if (!live || live.type !== node.type || live.color !== node.color) throw new Error('Node or schema changed. Reopen the picker.');
          };
          guard(); return choose(node, guard);
        }, finished, preflight);
        picker.open(); return () => { active = false; picker.dispose(); };
      },
      pickLinkTarget: (quote, choose) => this.plugin.native?.pickLinkTarget(quote, choose),
      highlightMenu: nativeHighlightMenu(this.app), linkMenu: nativeLinkMenu,
      visibleOverlays: () => [...this.contentEl.ownerDocument.querySelectorAll<HTMLElement>('.mobile-navbar, .mobile-toolbar')],
    });
  }
  // ReaderApp owns rendering; FileView owns the native file identity used for
  // repeated file opens. Never register .md globally or accept unrelated notes.
  canAcceptExtension(_extension: string): boolean { return false; }
  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}
  getReader() { return this.reader; }
  remapPosition(from: string, to: string) {
    const displayed = this.getState().file === from;
    this.reader?.remapPosition(from, to);
    if (displayed && this.savedState.file === from) this.savedState = { ...this.savedState, file: to };
  }
  remapPath(from: string, to: string) {
    const state = this.getState(), displayed = state.file === from || state.file === to;
    if (displayed) {
      // The synchronous position handoff may already have published `to`.
      this.stateRevision++; this.applyingState = false; this.appliedState = true;
      this.savedState = { ...state, file: to };
    }
    // A pending finish also needs renames of its next item. Do not adopt that
    // item's native/saved identity over the article currently displayed.
    this.reader?.remapPath(from, to);
    if (displayed) this.app.workspace.requestSaveLayout();
  }
  onPaneMenu(menu: Menu, source: string) { super.onPaneMenu(menu, source); this.plugin.native?.fillMenu(menu, this.reader); }
  getState(): Record<string, unknown> { return !this.appliedState || this.applyingState ? { ...this.savedState } : { ...this.savedState, ...this.reader?.getState() }; }
  async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    const revision = ++this.stateRevision, reader = this.reader, guard = this.plugin.routeGuard(this.leaf);
    const readingPosition = validateReadingPosition(state.readingPosition);
    this.savedState = { file: typeof state.file === 'string' ? state.file : undefined,
      readingPosition,
      queue: ['feed', 'inbox', 'later', 'archive'].includes(String(state.queue)) ? state.queue as ReaderState['queue'] : undefined,
      subpath: typeof state.subpath === 'string' ? state.subpath : undefined,
      scrollTop: typeof state.scrollTop === 'number' && Number.isFinite(state.scrollTop) ? Math.max(0, state.scrollTop) : undefined };
    this.applyingState = true;
    try {
      if (guard?.() === false) return;
      // FileView assigns identity synchronously, before its load hook awaits.
      await super.setState(state, result);
      if (revision !== this.stateRevision || reader !== this.reader || guard?.() === false) return;
      if (this.savedState.file) await reader?.open(this.savedState.file, { ...this.savedState, isCurrent: guard }); else await reader?.openDefault();
      if (revision !== this.stateRevision || reader !== this.reader || guard?.() === false) return;
    } finally { if (revision === this.stateRevision) { this.applyingState = false; this.appliedState = true; this.app.workspace.requestSaveLayout(); } }
  }
  disposeReader(): Promise<void> {
    this.chrome?.dispose(); this.chrome = undefined;
    this.savedState = this.getState(); this.stateRevision++;
    const flushed = this.reader?.destroy() ?? Promise.resolve(); this.reader = undefined;
    return this.plugin.trackReaderDisposal(flushed);
  }
  async onClose() { await this.disposeReader(); await super.onClose(); }
}
export default class ReaderPlugin extends Plugin {
  settings: ReaderSettings = { ...DEFAULT_SETTINGS };
  einkDevice: EinkDeviceSettings = normalizeEinkDevice(undefined);
  readonly supportsEink = Platform.isAndroidApp === true;
  private einkListeners = new Set<() => void>();
  controller!: ReaderController;
  private closing = false;
  private nativeRenames = new Set<Promise<void>>();
  private readerDisposals = new Set<Promise<void>>();
  trackReaderDisposal(write: Promise<void>): Promise<void> {
    this.readerDisposals.add(write);
    void write.finally(() => this.readerDisposals.delete(write)).catch(() => {});
    return write;
  }
  private routing?: ArticleRouting;
  native?: NativeReaderUI;
  private routeChecks = new WeakMap<WorkspaceLeaf, () => boolean>();
  private routeSeeds = new WeakMap<WorkspaceLeaf, ReaderState>();
  private resumeStates = new WeakMap<WorkspaceLeaf, ReaderState>();
  private templateExclusions: ArticleTemplateExclusions = {};
  private exclusionRefresh?: Promise<void>;
  private exclusionError?: Error;
  private exclusions(): ArticleTemplateExclusions { if (this.exclusionError) throw this.exclusionError; return this.templateExclusions; }
  private refreshExclusions(): Promise<void> {
    return this.exclusionRefresh ??= readTemplateExclusions(this.app).then(value => { this.templateExclusions = value; this.exclusionError = undefined; }).catch(error => {
      this.exclusionError = error instanceof Error ? error : new Error('Reader paused: template configuration could not be read safely.');
      this.controller?.setActive(false); throw this.exclusionError;
    }).finally(() => { this.exclusionRefresh = undefined; });
  }
  isEinkEnabled(): boolean { return einkEnabled(this.supportsEink, this.einkDevice); }
  subscribeEink(callback: () => void): () => void {
    if (this.closing) return () => {};
    this.einkListeners.add(callback); return () => { this.einkListeners.delete(callback); };
  }
  setEinkDevice(settings: EinkDeviceSettings): boolean {
    if (this.closing || !this.supportsEink) return false;
    const next = normalizeEinkDevice(settings);
    if (next.enabled === this.einkDevice.enabled && next.reverseButtons === this.einkDevice.reverseButtons) return true;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) {
      if (!(leaf.view instanceof ReaderView)) continue;
      const article = leaf.view.contentEl.querySelector('.r2-reading-page'), selection = leaf.view.contentEl.ownerDocument.getSelection();
      if (!article || !selection || selection.isCollapsed) continue;
      for (let index = 0; index < selection.rangeCount; index++) if (selection.getRangeAt(index).intersectsNode(article)) {
        new Notice('Clear the selected text in Reader, then retry changing the Boox / e-ink settings.'); return false;
      }
    }
    const persisted = writeEinkDevice(window, next); this.einkDevice = next;
    if (!persisted) new Notice('Boox / e-ink settings apply for this session only: device-local storage is unavailable.');
    for (const callback of [...this.einkListeners]) callback();
    return true;
  }
  routeGuard(leaf: WorkspaceLeaf) { return this.routeChecks.get(leaf); }
  routeState(leaf: WorkspaceLeaf) { return this.routeSeeds.get(leaf); }
  async openMarkdown(leaf: WorkspaceLeaf, path: string): Promise<void> {
    if (this.closing || !this.app.vault.getFileByPath(path)) throw new Error('Markdown note is unavailable.');
    const cancel = this.routing?.preserveMarkdown(leaf, path);
    try { await leaf.setViewState({ type: 'markdown', state: { file: path, mode: 'source' } }); }
    catch (error) { cancel?.(); throw error; }
  }
  async onload() {
    const resumed = (this.app as unknown as Record<symbol, unknown>)[RESUME]; if (resumed instanceof WeakMap) this.resumeStates = resumed;
    const context = this.app as unknown as Record<symbol, Promise<void> | undefined>;
    await context[BARRIER];
    if (this.closing) return;
    this.einkDevice = readEinkDevice(window);
    const saved = await this.loadData();
    if (this.closing) return;
    if (saved && typeof saved === 'object') for (const [key, value] of Object.entries(saved)) {
      if (!(key in DEFAULT_SETTINGS) || key === 'typedHighlightTypes') (this.settings as unknown as Record<string, unknown>)[key] = value;
    }
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ReaderSettings)[]) {
      if (key === 'typedHighlightTypes') continue; // Retired settings remain inert and round-trip unchanged.
      if (saved && typeof saved[key] === typeof DEFAULT_SETTINGS[key]) (this.settings as unknown as Record<string, unknown>)[key] = saved[key];
    }
    Object.assign(this.settings, normalizeFeedSchedule(saved));
    this.settings.maxFeedItems = Math.max(1, Math.min(500, Number(this.settings.maxFeedItems) || 50));
    await this.refreshExclusions().catch(error => { new Notice(error.message); throw error; }); if (this.closing) return;
    const repository = new ReaderRepository(new ObsidianStore(this.app.vault, this.app.workspace), this.settings, () => this.exclusions());
    this.controller = new ReaderController(repository, obsidianGet, this.settings, () => this.refreshExclusions());
    this.registerView(VIEW, leaf => new ReaderView(leaf, this));
    this.native = new NativeReaderUI(this, this.controller, () => {
      const view = this.app.workspace.activeLeaf?.view; return view instanceof ReaderView ? view.getReader() : undefined;
    }, async () => {
      const view = await this.openReader(), reader = view?.getReader(); if (!reader) throw new Error('Reader is unavailable.'); return reader;
    });
    this.routing = installArticleRouting({ app: this.app, readerViewType: VIEW, templateExclusions: () => this.exclusions(), onError: error => new Notice(String(error)), openReaderInLeaf: (leaf, request) => {
      if (this.closing || !request.isCurrent() || isArticleTemplatePath(request.path, this.exclusions())) return;
      const old = this.resumeStates.get(leaf), previous = old?.file === request.path ? old : undefined; this.resumeStates.delete(leaf);
      this.routeChecks.set(leaf, request.isCurrent); const state = { ...previous, file: request.path, subpath: request.subpath ?? previous?.subpath }; this.routeSeeds.set(leaf, state);
      const transition = leaf.setViewState({ type: VIEW, state }, request.ephemeralState);
      return transition.then(() => { if (!request.isCurrent()) return; }).finally(() => {
        if (this.routeChecks.get(leaf) === request.isCurrent) { this.routeChecks.delete(leaf); this.routeSeeds.delete(leaf); }
      });
    } });
    this.register(() => this.routing?.dispose());
    this.addRibbonIcon('list', 'Reading list', () => {
      void this.openReader().then(view => view?.getReader()?.openLibrary()).catch(error => new Notice(error instanceof Error ? error.message : String(error)));
    });
    this.addCommand({ id: 'refresh-feeds', name: 'Refresh feeds', callback: () => { void this.controller.refreshFeeds().catch(e => new Notice(String(e))); } });
    this.addCommand({ id: 'clean-up-stream', name: 'Clean up Stream', callback: () => { void this.controller.cleanupStream().then(message => new Notice(message)).catch(e => new Notice(String(e))); } });
    this.addSettingTab(new ReaderSettingsTab(this.app, this));
    const activate = () => this.controller.setActive(!this.closing && !document.hidden && !this.nativeRenames.size);
    const reportStorageError = (error: unknown) => {
      if (this.closing) return;
      const message = 'Reader note update failed; the source was preserved: ' + String(error);
      this.controller.message = message; this.controller.changed(); new Notice(message, 0);
    };
    const changed = () => {
      if (this.closing) return; this.controller.setActive(false);
      void this.refreshExclusions().then(() => { if (!this.closing) { activate(); this.controller.vaultChanged(); } }).catch(error => { this.controller.message = String(error); this.controller.changed(); });
    };
    const contentChanged = (file: TAbstractFile) => {
      if (this.closing) return;
      if (file instanceof TFile && file.extension.toLowerCase() === 'md') changed();
    };
    this.registerEvent(this.app.vault.on('create', contentChanged));
    this.registerEvent(this.app.vault.on('modify', contentChanged));
    this.registerEvent(this.app.vault.on('delete', nativeDeleteHandler(this.controller, changed, reportStorageError, () => this.closing)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.closing) return;
      const files = (file instanceof TFile ? [file] : this.app.vault.getMarkdownFiles().filter(item => item.path.startsWith(file.path + '/')))
        .filter(item => item.extension.toLowerCase() === 'md');
      if (!files.length) return;
      this.controller.setActive(false);
      // Start every relocation now so all old/new generations are invalidated before awaiting.
      const updates = files.map(moved => {
        const from = oldPath + moved.path.slice(file.path.length), to = moved.path;
        return { from, to, moved, ready: Promise.resolve(this.controller.articleRenamed(from, to)) };
      });
      // Generation invalidation above is synchronous. Hand position ownership to
      // the verified destination before awaiting anything or allowing close/unload.
      this.app.workspace.iterateAllLeaves(leaf => {
        if (!(leaf.view instanceof ReaderView)) return;
        for (const { from, to, moved } of updates) if (this.app.vault.getFileByPath(to) === moved) leaf.view.remapPosition(from, to);
      });
      const task = Promise.allSettled(updates.map(async ({ from, to, ready }) => {
        await ready;
        if (this.closing) return;
        this.routing?.remapPath(from, to);
        this.app.workspace.iterateAllLeaves(leaf => {
          for (const states of [this.routeSeeds, this.resumeStates]) {
            const state = states.get(leaf);
            if (state?.file === from) { states.set(leaf, { ...state, file: to }); this.routeChecks.delete(leaf); }
          }
          if (leaf.view instanceof ReaderView) leaf.view.remapPath(from, to);
        });
      })).then(results => {
        for (const result of results) if (result.status === 'rejected') reportStorageError(result.reason);
      });
      this.nativeRenames.add(task);
      void task.finally(() => { this.nativeRenames.delete(task); changed(); }).catch(reportStorageError);
    }));
    const editorChanged = () => { if (!this.closing) this.controller.vaultChanged(); };
    this.registerEvent(this.app.workspace.on('editor-change', editorChanged));
    this.registerEvent(this.app.workspace.on('layout-change', editorChanged));
    this.app.workspace.onLayoutReady(() => {
      if (this.closing) return;
      this.controller.setOnline(navigator.onLine); activate();
      if (this.nativeRenames.size) return;
      void this.controller.refreshFeeds(false).catch(e => { this.controller.message = String(e); this.controller.changed(); });
    });
    const foreground = () => {
      this.controller.setOnline(navigator.onLine); this.controller.setActive(false);
      if (!document.hidden && !this.closing) void this.refreshExclusions().then(() => {
        if (document.hidden || this.closing || this.nativeRenames.size) return; activate();
        return this.controller.refreshFeeds(false);
      }).catch(e => { this.controller.message = String(e); this.controller.changed(); });
    };
    this.registerDomEvent(document, 'visibilitychange', foreground);
    this.registerDomEvent(window, 'online', foreground);
    this.registerDomEvent(window, 'offline', () => this.controller.setOnline(false));
    this.registerInterval(window.setInterval(() => {
      if (!document.hidden && !this.closing) {
        void this.refreshExclusions().then(() => {
          if (this.closing || document.hidden || this.nativeRenames.size) return; activate(); this.controller.scheduleAcquisition(); return this.controller.refreshFeeds(false);
        }).catch(e => { this.controller.message = String(e); this.controller.changed(); });
      }
    }, 60000));
  }
  async openReader(): Promise<ReaderView | undefined> {
    if (this.closing) return undefined;
    const active = this.app.workspace.activeLeaf;
    let leaf = active?.view instanceof ReaderView ? active : this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
    if (this.closing || !(leaf.view instanceof ReaderView)) return undefined;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const target = leaf.view.contentEl.querySelector<HTMLElement>('.r2-article-title') ?? leaf.view.contentEl.querySelector<HTMLElement>('.r2-app');
    if (target) { if (!target.hasAttribute('tabindex')) target.tabIndex = -1; target.focus({ preventScroll: true }); }
    return leaf.view;
  }
  async saveSettings() { await this.saveData(this.settings); }
  onunload() {
    this.closing = true; this.einkListeners.clear(); this.routing?.dispose(); this.native?.dispose();
    const restoring: Promise<unknown>[] = []; (this.app as unknown as Record<symbol, unknown>)[RESUME] = this.resumeStates;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) if (leaf.view instanceof ReaderView) {
      const state = leaf.view.getState(), file = state.file; this.resumeStates.set(leaf, state); restoring.push(leaf.view.disposeReader());
      if (typeof file === 'string' && this.app.vault.getFileByPath(file)) restoring.push(leaf.setViewState({ type: 'markdown', state: { file } }));
    }
    const context = this.app as unknown as Record<symbol, Promise<void> | undefined>;
    context[BARRIER] = Promise.allSettled([
      ...(this.controller ? [this.controller.shutdown()] : []),
      ...this.nativeRenames, ...this.readerDisposals, ...restoring,
    ]).then(() => { this.controller?.repository?.disposeStorage(); });
  }
}
