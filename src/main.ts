import {
  FileView,
  MarkdownView,
  Notice,
  parseLinktext,
  Platform,
  Plugin,
  TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import { hasAnnotations, hasPropertyAnnotations, isAnnotationProperty } from './core/annotations';
import { queueAt, type Queue } from './core/model';
import { defaultFolders, validateFolders, type ReaderFolders } from './core/folders';
import { SerialWrites } from './core/work';
import { loadFolders, saveFolderSettings } from './host/folder-settings';
import { Network } from './host/network';
import { readDocument } from './core/document';
import { ArticleStore } from './core/store';
import { confirmArticleReplacement, input } from './host/dialogs';
import { Ingestion } from './host/ingestion';
import { ReaderSettings, showFeeds } from './host/settings';
import { ObsidianVault, watchLibrary, type LibraryChange } from './host/vault';
import { nativeLinkPath, READER_VIEW, ReaderView } from './reader/view';

export default class ReaderPlugin extends Plugin {
  store!: ArticleStore<TFile>;
  ingestion!: Ingestion;
  private lifetime = new AbortController();
  private unloaded = false;
  private vault!: ObsidianVault;
  private network = new Network();
  private folderSaves = new SerialWrites<string>();
  private viewWrites = new Set<Promise<unknown>>();
  private presentations = new Map<WorkspaceLeaf, Promise<void>>();
  private routingEpoch = 0;
  private sourceLeaves = new Map<WorkspaceLeaf, { file: TFile; transitioning: boolean }>();
  private attempted = new Set<string>();
  private promotions = new Map<TFile, boolean>();
  private promoting = new Set<TFile>();
  private lastMaintenance = 0;
  private refreshing = false;
  private referencesReady = false;
  private referencesRecovered = false;
  private startupCaptureRecoveryPending = true;
  private deferredCaptureSeeds = new Set<TFile>();
  private stopIndex?: () => void;
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }
  get paged(): boolean {
    try {
      return localStorage.getItem('obsidian-reader:eink') === '1';
    } catch {
      return false;
    }
  }
  private views(): ReaderView[] {
    return this.app.workspace
      .getLeavesOfType(READER_VIEW)
      .map((leaf) => leaf.view)
      .filter((view): view is ReaderView => view instanceof ReaderView);
  }
  private notice(error: unknown): void {
    if (!this.signal.aborted) new Notice(error instanceof Error ? error.message : String(error));
  }
  async onload(): Promise<void> {
    const data = await this.loadData();
    if (this.unloaded) return;
    let folders = defaultFolders;
    let invalid = false;
    try {
      folders = loadFolders(data);
    } catch (error) {
      invalid = true;
      this.notice(`Reader is paused until its folder settings are corrected: ${String(error)}`);
    }
    this.startFolders(folders);
    if (invalid) this.stopFolders();
    this.registerView(READER_VIEW, (leaf) => new ReaderView(leaf, this.readerHost()));
    const openReadingList = () => {
      if (!this.signal.aborted) void this.openList().catch((error) => this.notice(error));
    };
    this.addRibbonIcon('book-open', 'Reading list', openReadingList);
    this.addCommand({
      id: 'open-reader',
      name: 'Open reading list',
      callback: openReadingList,
    });
    this.registerObsidianProtocolHandler(READER_VIEW, (params) => {
      // Core Obsidian URI routing selects the vault. Interpret only our view selector.
      if (params.view === 'list') openReadingList();
    });
    this.addCommand({
      id: 'copy-reading-list-link',
      name: 'Copy reading-list link',
      callback: () => this.copyReadingListLink(),
    });
    this.addCommand({
      id: 'open-archive',
      name: 'Open Archive',
      callback: () => {
        void this.openList('Archive').catch((error) => this.notice(error));
      },
    });
    this.addCommand({ id: 'add-url', name: 'Add URL', callback: () => this.capture() });
    this.addCommand({
      id: 'redownload-article',
      name: 'Run Defuddle again (replace article content)',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(ReaderView),
          native = this.app.workspace.getActiveViewOfType(MarkdownView),
          file = view?.file ?? native?.file;
        // Source/live-preview editors remain protected, even when apparently clean.
        if (!view && native?.getMode() !== 'preview') return false;
        if (this.signal.aborted || !file || !this.store.catalog.article(file.path)?.url)
          return false;
        if (!checking)
          void this.redownloadArticle(file, view ?? undefined).catch((error) => this.notice(error));
        return true;
      },
    });
    this.addCommand({ id: 'manage-feeds', name: 'Manage feeds', callback: () => this.feeds() });
    this.addCommand({
      id: 'refresh-feeds',
      name: 'Refresh feeds',
      callback: () => {
        void this.tick(true).catch((error) => this.notice(error));
      },
    });
    for (const [id, name] of [
      ['move', 'Change article status…'],
      ['topics', 'Edit article topics…'],
      ['open-markdown', 'Open article as Markdown'],
    ] as const) {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) =>
          this.app.workspace.getActiveViewOfType(ReaderView)?.articleCommand(id, checking) ?? false,
      });
    }
    this.addSettingTab(
      new ReaderSettings(
        this.app,
        this,
        folders,
        this.paged,
        (next) => this.applyFolders(next),
        (value) => {
          try {
            localStorage.setItem('obsidian-reader:eink', value ? '1' : '0');
          } catch (error) {
            this.notice(error);
          }
        },
      ),
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.syncMobileNavigation();
        this.pruneSourceLeaves();
        this.routeArticle();
      }),
    );
    this.syncMobileNavigation();
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        this.syncMobileNavigation();
        this.pruneSourceLeaves();
        this.routeArticle(file);
      }),
    );
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.syncMobileNavigation();
        this.pruneSourceLeaves();
        for (const file of this.promotions.keys()) void this.promote(file);
      }),
    );
    this.registerDomEvent(document, 'keydown', (event) =>
      this.app.workspace.getActiveViewOfType(ReaderView)?.key(event),
    );
    this.registerDomEvent(window, 'online', () => {
      this.attempted.clear();
      void this.tick(false, true, true).catch((error) => this.notice(error));
    });
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible')
        void this.tick(false, true).catch((error) => this.notice(error));
      else this.flushViews();
    });
    this.registerDomEvent(window, 'pagehide', () => this.flushViews());
    // Automatic ticks retain housekeeping, never feed imports.
    this.registerInterval(
      window.setInterval(() => {
        void this.tick().catch((error) => this.notice(error));
      }, 60_000),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        this.referencesReady = false;
        if (this.app.workspace.getActiveViewOfType(MarkdownView)?.file === file)
          this.routeArticle(file);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('resolve', (file) => {
        if (!this.signal.aborted) {
          this.indexCapture(file);
          this.keepReferences(file);
          // Native Quick Capture may publish its body sections after `changed`.
          this.recover(file);
        }
        if (this.app.workspace.getActiveViewOfType(MarkdownView)?.file === file)
          this.routeArticle(file);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('resolved', () => {
        if (this.signal.aborted) return;
        const first = !this.referencesRecovered;
        if (first && !this.recoverReferences()) return;
        this.referencesReady = true;
        if (this.startupCaptureRecoveryPending) {
          this.startupCaptureRecoveryPending = false;
          // recoverReferences indexed notes whose frontmatter arrived late.
          this.recoverCaptures();
        }
        if (first) void this.expire().catch((error) => this.notice(error));
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      if (this.signal.aborted) return;
      this.syncMobileNavigation();
      this.routeArticle();
      // Late plugin loads may never see the initial resolved event. Complete per-file
      // metadata lets us reconstruct native references directly, without resolvedLinks.
      if (!this.referencesRecovered && this.recoverReferences()) this.referencesReady = true;
      if (this.referencesReady && this.startupCaptureRecoveryPending) {
        this.startupCaptureRecoveryPending = false;
        this.recoverCaptures();
      }
      void this.tick(false, true).catch((error) => this.notice(error));
    });
  }
  private readerHost(): ConstructorParameters<typeof ReaderView>[1] {
    const plugin = this,
      signal = this.signal;
    return Object.freeze({
      app: this.app,
      store: this.store,
      ingestion: this.ingestion,
      signal,
      get paged() {
        return plugin.paged;
      },
      capture: () => {
        if (!signal.aborted) plugin.capture();
      },
      feeds: () => {
        if (!signal.aborted) plugin.feeds();
      },
      edit: async (view: ReaderView, file: TFile) => {
        if (!signal.aborted) await plugin.edit(view, file);
      },
      refreshPresentation: async (view: ReaderView, valid: () => boolean) => {
        if (!signal.aborted) await plugin.refreshPresentation(view, valid);
      },
    });
  }
  private startFolders(folders: ReaderFolders): void {
    const signal = this.signal;
    this.vault = new ObsidianVault(this.app, () => !signal.aborted);
    this.store = new ArticleStore(this.vault, folders);
    this.ingestion = new Ingestion(
      this.store,
      (message) => {
        if (!signal.aborted) this.notice(message);
      },
      this.network,
    );
    this.stopIndex = watchLibrary(this, this.store, (change) => {
      if (!signal.aborted) this.changed(change);
    });
  }
  private stopFolders(): void {
    this.lifetime.abort();
    this.routingEpoch++;
    this.ingestion?.stop();
    this.stopIndex?.();
    this.store?.dispose();
  }
  private dispatchView<T>(operation: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(new Error('Reader is paused.'));
    const result = operation();
    this.viewWrites.add(result);
    const clear = () => this.viewWrites.delete(result);
    void result.then(clear, clear);
    return result;
  }
  refreshPresentation(view: ReaderView, valid: () => boolean = () => true): Promise<void> {
    const signal = this.signal,
      leaf = view.leaf;
    const current = () =>
      !signal.aborted &&
      valid() &&
      leaf.view === view &&
      !this.sourceLeaves.get(leaf)?.transitioning;
    if (!current()) return Promise.resolve();
    const previous = this.presentations.get(leaf) ?? Promise.resolve();
    const request = previous
      .catch(() => {})
      .then(async () => {
        if (!current()) return;
        await this.dispatchView(() =>
          leaf.setViewState({ type: READER_VIEW, state: { readerPresentationOnly: true } }),
        );
      });
    this.presentations.set(leaf, request);
    const clear = () => {
      if (this.presentations.get(leaf) === request) this.presentations.delete(leaf);
    };
    void request.then(clear, clear);
    return request;
  }
  private applyFolders(candidate: ReaderFolders): Promise<void> {
    const folders = validateFolders(candidate);
    return this.folderSaves.run('folders', async () => {
      const assertLoaded = () => {
        if (this.unloaded) throw new Error('Reader has stopped.');
      };
      assertLoaded();
      const data = await this.loadData();
      assertLoaded();
      await this.saveData(saveFolderSettings(data, folders));
      assertLoaded();
      // No candidate path becomes live until the complete group is valid and durable.
      for (const view of this.views()) view.stopForUnload();
      this.stopFolders();
      while (this.viewWrites.size) await Promise.allSettled([...this.viewWrites]);
      await this.vault.drain();
      assertLoaded();
      const cleared = await Promise.allSettled(
        this.views().map(async (view) => {
          const leaf = view.leaf;
          view.stopForUnload();
          if (leaf.view !== view) return;
          await leaf.setViewState({ type: 'empty', active: false });
          const empty = leaf.view;
          return empty.getViewType() === 'empty' ? { leaf, empty } : undefined;
        }),
      );
      assertLoaded();
      if (cleared.some((result) => result.status === 'rejected'))
        throw new Error(
          'Folders saved, but a Reader tab could not close. Reader is paused; retry Apply folders.',
        );
      const reset = cleared.flatMap((result) =>
        result.status === 'fulfilled' && result.value ? [result.value] : [],
      );
      this.attempted = new Set();
      this.promotions = new Map();
      this.promoting = new Set();
      this.lastMaintenance = 0;
      this.refreshing = false;
      this.referencesReady = this.referencesRecovered = false;
      this.lifetime = new AbortController();
      // Applying folders is not a new startup and must not acquire existing notes.
      this.startupCaptureRecoveryPending = false;
      // Metadata replay after Apply is not a request to acquire existing files.
      // New native captures have new identities and remain eligible immediately.
      this.deferredCaptureSeeds = new Set(this.app.vault.getMarkdownFiles());
      this.startFolders(folders);
      const signal = this.signal;
      // Metadata-only reseed above: never recover/acquire/promote or reopen articles here.
      const reopened = await Promise.allSettled(
        reset.map(async (entry) => {
          if (!entry || entry.leaf.view !== entry.empty || signal.aborted) return;
          let attached = false;
          this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf === entry.leaf) attached = true;
          });
          if (attached)
            await this.dispatchView(() =>
              entry.leaf.setViewState({ type: READER_VIEW, state: {}, active: false }),
            );
        }),
      );
      assertLoaded();
      if (reopened.some((result) => result.status === 'rejected'))
        this.notice('Folders applied, but a Reader tab could not reopen. Use Open reading list.');
      this.syncMobileNavigation();
    });
  }
  private routeArticle(opened?: TFile | null): void {
    const epoch = ++this.routingEpoch,
      signal = this.signal,
      store = this.store;
    if (this.signal.aborted || opened === null) return;
    const leaf = this.app.workspace.getMostRecentLeaf(),
      view = this.app.workspace.getActiveViewOfType(MarkdownView),
      file = view?.file;
    if (
      !leaf ||
      !view ||
      leaf.view !== view ||
      !(file instanceof TFile) ||
      (opened !== undefined && opened !== file) ||
      file.extension !== 'md' ||
      this.sourceLeaves.get(leaf)?.file === file
    )
      return;
    const path = file.path,
      revision = file.stat && { mtime: file.stat.mtime, size: file.stat.size };
    if (!revision) return;
    // Public Editor bytes are the only evidence of a clean native buffer. Never
    // replace a loading/uncertain editor, even when the metadata cache says article.
    let buffer: string;
    try {
      buffer = view.editor?.getValue();
      if (typeof buffer !== 'string') return;
    } catch {
      return;
    }
    const current = () =>
      !signal.aborted &&
      epoch === this.routingEpoch &&
      this.app.workspace.getMostRecentLeaf() === leaf &&
      this.app.workspace.getActiveViewOfType(MarkdownView) === view &&
      leaf.view === view &&
      view.file === file &&
      file.path === path &&
      store.vault.file(path) === file &&
      file.stat.mtime === revision.mtime &&
      file.stat.size === revision.size &&
      this.sourceLeaves.get(leaf)?.file !== file &&
      !document.querySelector('.modal-container,.menu') &&
      document.getSelection()?.isCollapsed !== false &&
      // Inline properties/titles may have uncommitted input outside Editor bytes.
      (!(document.activeElement instanceof Element) ||
        !document.activeElement.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
        ) ||
        view.editor?.hasFocus?.() === true) &&
      view.editor?.getValue() === buffer;
    void (async () => {
      const raw = await store.vault.read(file);
      if (!current() || raw !== buffer || readDocument(raw).properties.type !== 'article') return;
      // No await between the final intent/buffer check and public dispatch. Do not
      // request focus: a host transition must not activate a now-background leaf.
      await this.dispatchView(() =>
        leaf.setViewState({ type: READER_VIEW, state: { file: path } }),
      );
      if (!signal.aborted) this.syncMobileNavigation();
    })().catch(() => {
      // Passive routing is optional. Read/parse/editor uncertainty leaves Markdown intact.
    });
  }
  private syncMobileNavigation(): void {
    if (this.signal.aborted) return;
    document.body.classList.toggle(
      'reader-mobile-active',
      Platform.isMobile && !!this.app.workspace.getActiveViewOfType(ReaderView),
    );
  }
  private pruneSourceLeaves(): void {
    const open = new Set<WorkspaceLeaf>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      open.add(leaf);
    });
    for (const [leaf, entry] of this.sourceLeaves) {
      if (
        !entry.transitioning &&
        (!open.has(leaf) || !(leaf.view instanceof MarkdownView) || leaf.view.file !== entry.file)
      )
        this.sourceLeaves.delete(leaf);
    }
  }
  private flushViews(): void {
    const signal = this.signal;
    if (signal.aborted) return;
    for (const view of this.views())
      void view.flush().catch((error) => {
        if (!signal.aborted) this.notice(error);
      });
  }
  private changed(change: LibraryChange): void {
    const signal = this.signal;
    if (signal.aborted) return;
    for (const view of this.views())
      void view.changed(change).catch((error) => {
        if (!signal.aborted) this.notice(error);
      });
    const file = this.store.vault.file(change.path);
    if (!file) return;
    this.recover(file);
    if (change.annotations && this.store.catalog.article(file.path)?.queue === 'Feed') {
      if (!this.promotions.has(file)) this.promotions.set(file, false);
      void this.promote(file);
    }
    this.keepReferences(file);
  }
  private keepReferences(file: TFile, cache = this.app.metadataCache.getFileCache(file)): void {
    if (!cache) {
      // A missing public cache must not be mistaken for a complete, link-free note.
      this.referencesReady = this.referencesRecovered = false;
      return;
    }
    const properties = cache.frontmatter ?? {};
    if (
      this.store.catalog.article(file.path)?.queue === 'Feed' &&
      hasPropertyAnnotations(properties)
    ) {
      if (!this.promotions.has(file)) this.promotions.set(file, false);
      void this.promote(file); // Revalidate the authored properties against current bytes.
    }
    // Reader source/state values (especially feed and bookmark) are not
    // authored backlinks. The same keys on ordinary notes remain native references.
    const frontmatterLinks = (cache.frontmatterLinks ?? []).filter((link) =>
      isAnnotationProperty(properties, link.key),
    );
    // Keep only native note references, never publisher TOCs, protocol-relative URLs or schemes.
    for (const link of [...(cache.links ?? []), ...frontmatterLinks]) {
      if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(link.link.trim())) continue;
      const wiki = /^!?\[\[/.test(link.original ?? '');
      const decoded = nativeLinkPath(link.link, !wiki);
      if (!decoded) continue;
      const path = parseLinktext(decoded).path;
      if (!path) continue;
      const target = this.app.metadataCache.getFirstLinkpathDest(path, file.path);
      if (target && this.store.catalog.article(target.path)?.queue === 'Feed') {
        this.promotions.set(target, true);
        void this.promote(target);
      }
    }
  }
  private async promote(file: TFile): Promise<void> {
    if (this.promoting.has(file) || this.signal.aborted) return;
    if (this.store.catalog.article(file.path)?.queue !== 'Feed') {
      this.promotions.delete(file);
      return;
    }
    if (this.views().some((view) => view.protects(file) && view.busy)) return;
    const signal = this.signal,
      store = this.store,
      promotions = this.promotions,
      promoting = this.promoting;
    promoting.add(file);
    try {
      const snapshot = await store.read(file.path);
      if (signal.aborted) return;
      // Metadata can lag native/synced edits. Only current feed/missing status
      // permits promotion; invalid and retained statuses are never rewritten.
      if (
        queueAt(snapshot.properties) === 'Feed' &&
        (promotions.get(file) || hasAnnotations(snapshot.body, snapshot.properties))
      )
        await store.move(snapshot, 'Later');
      promotions.delete(file);
    } catch {
      /* A native editor or a concurrent edit can defer the move; retry on layout/save. */
    } finally {
      promoting.delete(file);
    }
  }
  private recoverReferences(): boolean {
    // One complete startup pass over public metadata, never note bodies. A missing
    // file cache keeps expiry disabled until a later resolved event can complete it.
    const entries = this.app.vault
      .getMarkdownFiles()
      .map((file) => ({ file, cache: this.app.metadataCache.getFileCache(file) }));
    if (entries.some((entry) => !entry.cache)) {
      this.referencesReady = this.referencesRecovered = false;
      return false;
    }
    // Aggregated resolvedLinks loses provenance (e.g. #TOC self-links). Resolve the
    // cached source links themselves, preserving native targets before enabling expiry.
    for (const { file, cache } of entries) {
      if (this.startupCaptureRecoveryPending) this.indexCapture(file);
      this.keepReferences(file, cache);
    }
    this.referencesRecovered = true;
    return true;
  }
  private expire(): Promise<unknown> {
    const signal = this.signal,
      store = this.store,
      promotions = this.promotions;
    if (!this.referencesReady || signal.aborted) return Promise.resolve();
    return store.expire(new Date(), (file) => {
      if (
        signal.aborted ||
        !this.referencesReady ||
        promotions.has(file) ||
        this.views().some((view) => view.protects(file))
      )
        return true;
      let open = false;
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view instanceof FileView && leaf.view.file === file) open = true;
      });
      return open;
    });
  }
  private recover(file: TFile): void {
    if (
      this.signal.aborted ||
      !navigator.onLine ||
      document.visibilityState !== 'visible' ||
      this.attempted.has(file.path) ||
      this.deferredCaptureSeeds.has(file)
    )
      return;
    const article = this.store.catalog.article(file.path);
    if (!article?.url || !['Inbox', 'Later'].includes(article.queue ?? '')) return;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.sections) return;
    const bodySections = cache.sections.filter((section) => section.type !== 'yaml');
    if (bodySections.length) {
      // Metadata-only shortlist. The acquisition queue bounds actual body reads,
      // then the shared byte predicate proves the standalone source link again.
      if (
        bodySections.length !== 1 ||
        bodySections[0]!.type !== 'paragraph' ||
        cache.links?.length !== 1 ||
        cache.links[0]!.link !== cache.frontmatter?.url
      )
        return;
    }
    this.attempted.add(file.path);
    const signal = this.signal;
    void this.ingestion.acquire(file.path).catch((error) => {
      if (!signal.aborted) this.notice(error);
    });
  }
  private indexCapture(file: TFile): void {
    if (this.signal.aborted || file.extension !== 'md' || this.store.vault.file(file.path) !== file)
      return;
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache?.frontmatter) this.store.catalog.update(file.path, cache.frontmatter);
  }
  private recoverCaptures(): void {
    if (this.signal.aborted) return;
    // Explicit foreground/online recovery releases Apply's metadata-replay hold.
    this.deferredCaptureSeeds.clear();
    // Metadata-only enumeration. recover() shortlists empty/source-link notes and bounds
    // each path to one attempt per generation (reset when connectivity returns).
    for (const article of this.store.catalog.values()) {
      const file = this.store.vault.file(article.path);
      if (file) this.recover(file);
    }
  }
  private async tick(syncFeeds = false, recover = false, forceMaintenance = false): Promise<void> {
    const signal = this.signal,
      ingestion = this.ingestion;
    if (signal.aborted || document.visibilityState !== 'visible') return;
    if (this.refreshing) {
      // An explicit Sync must not disappear behind expiry-only housekeeping.
      // Keep its captured ingestion generation, without taking maintenance ownership.
      try {
        if (syncFeeds && navigator.onLine) await ingestion.refreshAll();
      } catch (error) {
        if (!signal.aborted) throw error;
      }
      return;
    }
    if (!this.referencesRecovered && this.recoverReferences()) this.referencesReady = true;
    if (recover) this.recoverCaptures();
    if (!syncFeeds && !forceMaintenance && Date.now() - this.lastMaintenance < 4 * 60 * 60 * 1000)
      return;
    this.refreshing = true;
    this.lastMaintenance = Date.now();
    try {
      // Only the explicit Refresh feeds command sets syncFeeds. Online/startup/
      // visibility/timer callbacks may recover captures and expire Feed notes.
      if (syncFeeds && navigator.onLine) await ingestion.refreshAll();
      if (!signal.aborted) await this.expire();
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      if (!signal.aborted) this.refreshing = false;
    }
  }
  private async copyReadingListLink(): Promise<void> {
    if (this.signal.aborted) return;
    try {
      const clipboard = navigator.clipboard;
      if (typeof clipboard?.writeText !== 'function') {
        this.notice('Clipboard is unavailable on this device. Reading-list link was not copied.');
        return;
      }
      const link = `obsidian://${READER_VIEW}?vault=${encodeURIComponent(this.app.vault.getName())}&view=list`;
      await clipboard.writeText(link);
      this.notice('Reading-list link copied.');
    } catch (error) {
      this.notice(
        `Could not copy the reading-list link: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  async openList(queue?: Queue): Promise<ReaderView> {
    const signal = this.signal;
    if (signal.aborted) throw new Error('Reader is paused.');
    const existing = this.app.workspace.getActiveViewOfType(ReaderView);
    if (existing) {
      await existing.readingList(queue);
      if (signal.aborted) throw new Error('Reader settings changed.');
      return existing;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await this.dispatchView(() =>
      leaf.setViewState({ type: READER_VIEW, state: queue ? { queue } : {}, active: true }),
    );
    if (signal.aborted) throw new Error('Reader settings changed.');
    this.syncMobileNavigation();
    return leaf.view as ReaderView;
  }
  capture(): void {
    const signal = this.signal,
      store = this.store;
    if (signal.aborted) return;
    input(
      this.app,
      'Save article',
      'URL',
      async (url, modalSignal = signal) => {
        const active = () => !signal.aborted && !modalSignal.aborted;
        const guard = () => {
          if (!active()) throw new Error('Reader capture was cancelled.');
        };
        guard();
        const file = await store.capture({ url }, new Date(), guard);
        if (!active()) return;
        let view = this.app.workspace.getActiveViewOfType(ReaderView);
        let created: WorkspaceLeaf | undefined;
        if (!view) {
          const leaf = this.app.workspace.getLeaf('tab');
          created = leaf;
          // Do not focus a new tab while asynchronous host view creation is pending.
          await this.dispatchView(() =>
            leaf.setViewState({ type: READER_VIEW, state: {}, active: false }),
          );
          if (!(leaf.view instanceof ReaderView)) return;
          view = leaf.view;
        }
        if (!active()) {
          if (created && !view.file) created.detach();
          return;
        }
        await view.openArticle(file.path, false, modalSignal);
        if (!active()) {
          if (created && created.view === view && !view.file) created.detach();
          return;
        }
        if (view.leaf.view === view && view.file === file)
          await this.app.workspace.revealLeaf(view.leaf);
        // openArticle starts acquisition only after its final cancellation check.
        // Cancellation cannot roll back a note/native host operation already committed.
      },
      signal,
    );
  }
  private async redownloadArticle(file: TFile, view?: ReaderView): Promise<void> {
    const signal = this.signal,
      store = this.store,
      ingestion = this.ingestion;
    if (signal.aborted) return;
    // Settle Reader-owned edits first, then bind confirmation to exact durable bytes.
    if (view) await view.flush();
    if (signal.aborted || store.vault.file(file.path) !== file) return;
    const snapshot = await store.read(file.path);
    if (signal.aborted || snapshot.file !== file) return;
    await store.validate(snapshot);
    if (signal.aborted) return;
    confirmArticleReplacement(
      this.app,
      snapshot.path,
      async (modalSignal) => {
        if (signal.aborted) throw new Error('Reader has stopped.');
        await ingestion.redownload(snapshot, modalSignal);
      },
      signal,
    );
  }
  feeds(): void {
    if (this.signal.aborted) return;
    showFeeds(this.app, this.store, this.ingestion, this.signal);
  }
  async edit(view: ReaderView, file: TFile): Promise<void> {
    const signal = this.signal,
      store = this.store;
    if (signal.aborted) return;
    await view.prepareMarkdown();
    if (
      signal.aborted ||
      view.leaf.view !== view ||
      view.file !== file ||
      store.vault.file(file.path) !== file
    )
      return;
    const entry = { file, transitioning: true };
    this.sourceLeaves.set(view.leaf, entry);
    try {
      // A dispatched title-only refresh must settle before Markdown takes ownership.
      // The exemption above prevents any queued refresh from dispatching meanwhile.
      await this.presentations.get(view.leaf);
      if (
        signal.aborted ||
        view.leaf.view !== view ||
        view.file !== file ||
        store.vault.file(file.path) !== file
      )
        return;
      await this.dispatchView(() =>
        view.leaf.setViewState({
          type: 'markdown',
          state: { file: file.path, mode: 'source' },
          active: true,
        }),
      );
    } finally {
      entry.transitioning = false;
      if (!signal.aborted) {
        this.pruneSourceLeaves();
        this.syncMobileNavigation();
      }
    }
  }
  onunload(): void {
    // Obsidian does not await this hook. Stop writes rather than allow old instances
    // to finish mutations after Hot Reload. Normal closes/visibility changes drain earlier;
    // abrupt unload/process termination cannot guarantee the final unsaved selection/position.
    this.unloaded = true;
    this.lifetime.abort();
    this.network.stop();
    document.body.classList.remove('reader-mobile-active');
    this.ingestion?.stop();
    this.stopIndex?.();
    this.store?.dispose();
    this.sourceLeaves.clear();
    for (const view of this.views()) {
      view.stopForUnload();
      const file = view.file;
      if (file && this.store.vault.file(file.path) === file)
        void view.leaf
          .setViewState({ type: 'markdown', state: { file: file.path, mode: 'preview' } })
          .catch(() => {});
    }
  }
}
