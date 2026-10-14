import {
  FileView,
  MarkdownView,
  Notice,
  parseLinktext,
  Plugin,
  TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import { hasAnnotations, hasPropertyAnnotations, isAnnotationProperty } from './core/annotations';
import { rootPath } from './core/model';
import { ArticleStore } from './core/store';
import { input } from './host/dialogs';
import { Ingestion } from './host/ingestion';
import { ReaderSettings, showFeeds } from './host/settings';
import { ObsidianVault, watchLibrary, type LibraryChange } from './host/vault';
import { nativeLinkPath, READER_VIEW, ReaderView } from './reader/view';

export default class ReaderPlugin extends Plugin {
  store!: ArticleStore<TFile>;
  ingestion!: Ingestion;
  private lifetime = new AbortController();
  private sourceLeaves = new Map<WorkspaceLeaf, { file: TFile; transitioning: boolean }>();
  private attempted = new Set<string>();
  private promotions = new Map<TFile, boolean>();
  private promoting = new Set<TFile>();
  private lastRefresh = 0;
  private refreshing = false;
  private referencesReady = false;
  private referencesRecovered = false;
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
    let root = 'Reading';
    try {
      if (typeof data?.root === 'string') root = rootPath(data.root);
    } catch (error) {
      this.notice(error);
    }
    const vault = new ObsidianVault(this.app, () => !this.signal.aborted);
    this.store = new ArticleStore(vault, root);
    this.ingestion = new Ingestion(this.store, (message) => this.notice(message));
    this.stopIndex = watchLibrary(this, this.store, (change) => this.changed(change));
    this.registerView(READER_VIEW, (leaf) => new ReaderView(leaf, this));
    this.addRibbonIcon('book-open', 'Reading list', () => {
      void this.openList().catch((error) => this.notice(error));
    });
    this.addCommand({
      id: 'open-reader',
      name: 'Open reading list',
      callback: () => {
        void this.openList().catch((error) => this.notice(error));
      },
    });
    this.addCommand({ id: 'add-url', name: 'Add URL', callback: () => this.capture() });
    this.addCommand({ id: 'manage-feeds', name: 'Manage feeds', callback: () => this.feeds() });
    this.addCommand({
      id: 'refresh-feeds',
      name: 'Refresh feeds',
      callback: () => {
        void this.tick(true).catch((error) => this.notice(error));
      },
    });
    this.addCommand({
      id: 'open-markdown',
      name: 'Open article as Markdown',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(ReaderView);
        if (!view?.file) return false;
        if (!checking) void this.edit(view, view.file).catch((error) => this.notice(error));
        return true;
      },
    });
    this.addSettingTab(
      new ReaderSettings(
        this.app,
        this,
        root,
        this.paged,
        async (next) => {
          await this.saveData({ root: next });
        },
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
      this.app.workspace.on('file-open', (file) => {
        this.pruneSourceLeaves();
        if (
          !(file instanceof TFile) ||
          this.signal.aborted ||
          this.app.metadataCache.getFileCache(file)?.frontmatter?.type !== 'article'
        )
          return;
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (
          !leaf ||
          !(leaf.view instanceof MarkdownView) ||
          leaf.view.file !== file ||
          this.sourceLeaves.get(leaf)?.file === file
        )
          return;
        void leaf
          .setViewState({ type: READER_VIEW, state: { file: file.path }, active: true })
          .catch((error) => this.notice(error));
      }),
    );
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.pruneSourceLeaves();
        for (const file of this.promotions.keys()) void this.promote(file);
      }),
    );
    this.registerDomEvent(document, 'keydown', (event) =>
      this.app.workspace.getActiveViewOfType(ReaderView)?.key(event),
    );
    this.registerDomEvent(window, 'online', () => {
      this.attempted.clear();
      void this.tick(true, true).catch((error) => this.notice(error));
    });
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible')
        void this.tick(false, true).catch((error) => this.notice(error));
      else this.flushViews();
    });
    this.registerDomEvent(window, 'pagehide', () => this.flushViews());
    this.registerInterval(
      window.setInterval(() => {
        void this.tick().catch((error) => this.notice(error));
      }, 60_000),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', () => {
        this.referencesReady = false;
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('resolve', (file) => {
        if (!this.signal.aborted) this.keepReferences(file);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('resolved', () => {
        if (this.signal.aborted) return;
        const first = !this.referencesRecovered;
        if (first && !this.recoverReferences()) return;
        this.referencesReady = true;
        if (first) void this.expire().catch((error) => this.notice(error));
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      if (this.signal.aborted) return;
      // Late plugin loads may never see the initial resolved event. Complete per-file
      // metadata lets us reconstruct native references directly, without resolvedLinks.
      if (!this.referencesRecovered && this.recoverReferences()) this.referencesReady = true;
      void this.tick(false, true).catch((error) => this.notice(error));
    });
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
    for (const view of this.views()) void view.flush().catch((error) => this.notice(error));
  }
  private changed(change: LibraryChange): void {
    if (this.signal.aborted) return;
    for (const view of this.views()) void view.changed(change).catch((error) => this.notice(error));
    const file = this.store.vault.file(change.path);
    if (!file) return;
    this.recover(file);
    if (change.annotations && this.store.catalog.article(file.path)?.queue === 'Stream') {
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
      this.store.catalog.article(file.path)?.queue === 'Stream' &&
      hasPropertyAnnotations(properties)
    ) {
      if (!this.promotions.has(file)) this.promotions.set(file, false);
      void this.promote(file); // Revalidate the authored properties against current bytes.
    }
    // Reader source/state values (especially feed and reading_position) are not
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
      if (target && this.store.catalog.article(target.path)?.queue === 'Stream') {
        this.promotions.set(target, true);
        void this.promote(target);
      }
    }
  }
  private async promote(file: TFile): Promise<void> {
    if (this.promoting.has(file) || this.signal.aborted) return;
    if (this.store.catalog.article(file.path)?.queue !== 'Stream') {
      this.promotions.delete(file);
      return;
    }
    if (this.views().some((view) => view.protects(file) && view.busy)) return;
    this.promoting.add(file);
    try {
      const snapshot = await this.store.read(file.path);
      if (this.promotions.get(file) || hasAnnotations(snapshot.body, snapshot.properties))
        await this.store.move(snapshot, 'Inbox');
      this.promotions.delete(file);
    } catch {
      /* A native editor or a concurrent edit can defer the move; retry on layout/save. */
    } finally {
      this.promoting.delete(file);
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
    for (const { file, cache } of entries) this.keepReferences(file, cache);
    this.referencesRecovered = true;
    return true;
  }
  private expire(): Promise<unknown> {
    if (!this.referencesReady || this.signal.aborted) return Promise.resolve();
    return this.store.expire(new Date(), (file) => {
      if (
        !this.referencesReady ||
        this.signal.aborted ||
        this.promotions.has(file) ||
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
      this.attempted.has(file.path)
    )
      return;
    const article = this.store.catalog.article(file.path);
    if (!article?.url || !['Inbox', 'Later'].includes(article.queue ?? '')) return;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.sections || cache.sections.some((section) => section.type !== 'yaml')) return;
    this.attempted.add(file.path);
    void this.ingestion.acquire(file.path).catch((error) => this.notice(error));
  }
  private async tick(force = false, recover = false): Promise<void> {
    if (this.signal.aborted || document.visibilityState !== 'visible' || this.refreshing) return;
    if (recover)
      for (const article of this.store.catalog.values()) {
        const file = this.store.vault.file(article.path);
        if (file) this.recover(file);
      }
    if (!force && Date.now() - this.lastRefresh < 4 * 60 * 60 * 1000) return;
    this.refreshing = true;
    this.lastRefresh = Date.now();
    try {
      if (navigator.onLine) await this.ingestion.refreshAll();
      await this.expire();
    } finally {
      this.refreshing = false;
    }
  }
  async openList(): Promise<ReaderView> {
    const existing = this.app.workspace.getActiveViewOfType(ReaderView);
    if (existing) {
      await existing.readingList();
      return existing;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: READER_VIEW, state: {}, active: true });
    return leaf.view as ReaderView;
  }
  capture(): void {
    input(
      this.app,
      'Save article',
      'URL',
      async (url, modalSignal = this.signal) => {
        const active = () => !this.signal.aborted && !modalSignal.aborted;
        const guard = () => {
          if (!active()) throw new Error('Reader capture was cancelled.');
        };
        guard();
        const file = await this.store.capture({ url }, new Date(), guard);
        if (!active()) return;
        let view = this.app.workspace.getActiveViewOfType(ReaderView);
        let created: WorkspaceLeaf | undefined;
        if (!view) {
          const leaf = this.app.workspace.getLeaf('tab');
          created = leaf;
          // Do not focus a new tab while asynchronous host view creation is pending.
          await leaf.setViewState({ type: READER_VIEW, state: {}, active: false });
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
      this.signal,
    );
  }
  feeds(): void {
    showFeeds(this.app, this.store, this.ingestion, this.signal);
  }
  async edit(view: ReaderView, file: TFile): Promise<void> {
    await view.prepareMarkdown();
    if (
      this.signal.aborted ||
      view.leaf.view !== view ||
      view.file !== file ||
      this.store.vault.file(file.path) !== file
    )
      return;
    const entry = { file, transitioning: true };
    this.sourceLeaves.set(view.leaf, entry);
    try {
      await view.leaf.setViewState({
        type: 'markdown',
        state: { file: file.path, mode: 'source' },
        active: true,
      });
    } finally {
      entry.transitioning = false;
      this.pruneSourceLeaves();
    }
  }
  onunload(): void {
    // Obsidian does not await this hook. Stop writes rather than allow old instances
    // to finish mutations after Hot Reload. Normal closes/visibility changes drain earlier;
    // abrupt unload/process termination cannot guarantee the final unsaved selection/position.
    this.lifetime.abort();
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
