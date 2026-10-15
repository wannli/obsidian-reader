import {
  ItemView,
  Menu,
  Notice,
  parseLinktext,
  setIcon,
  setTooltip,
  type App,
  type TFile,
  type ViewStateResult,
  type WorkspaceLeaf,
} from 'obsidian';
import {
  addHighlight,
  changePassage,
  hasAnnotations,
  locateSelection,
  passages,
  UnmappableSelection,
  type Passage,
} from '../core/annotations';
import { ReadingQueue } from '../core/catalog';
import { patchProperties, readDocument, readingMarker, replaceBody } from '../core/document';
import { renderedHighlight } from '../core/markdown';
import { articleInfo, linkPath, queueAt, queues, text, vaultLink, type Queue } from '../core/model';
import { type ArticleStore, type Snapshot } from '../core/store';
import { choose, chooseTopics, confirmWebLink } from '../host/dialogs';
import type { Ingestion } from '../host/ingestion';
import { nodesApi, type NodesApi, type NodeResult } from '../host/nodes';
import type { LibraryChange } from '../host/vault';
import { ReadingSurface } from './surface';

export const READER_VIEW = 'obsidian-reader';
type PendingSelection = {
  readonly selection: Readonly<
    Pick<NonNullable<ReturnType<ReadingSurface['selection']>>, 'quote' | 'before' | 'after'>
  >;
  readonly body: string;
};
type BrowsingContext = { queue: Queue; paths: string[] };
/** Rendered hrefs are encoded once. Never reinterpret a decoded URI as a vault path. */
export function nativeLinkPath(value: string, encoded = true): string | undefined {
  let path: string;
  try {
    path = (encoded ? decodeURIComponent(value) : value).trim();
  } catch {
    return;
  }
  if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(path)) return;
  path = path.replace(/^\//, '');
  return path && !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(path) ? path : undefined;
}

/** Unlike openLinkText, this never asks Obsidian to create a missing note. */
export async function openExistingNote(
  app: App,
  target: string,
  source: string,
  newLeaf = false,
): Promise<void> {
  const safe = nativeLinkPath(target, false);
  if (!safe) throw new Error('This is not a vault-note link.');
  const { path, subpath } = parseLinktext(safe);
  const file = app.metadataCache.getFirstLinkpathDest(path, source);
  if (!file) throw new Error('The linked note no longer exists. No note was created.');
  const expected = file.path;
  const assert = () => {
    if (file.path !== expected || app.vault.getAbstractFileByPath(expected) !== file)
      throw new Error('The linked note changed. Reopen the link.');
  };
  assert();
  const leaf = app.workspace.getLeaf(newLeaf);
  assert();
  await leaf.openFile(file, { active: true, ...(subpath ? { eState: { subpath } } : {}) });
}

interface ReaderHost {
  app: App;
  store: ArticleStore<TFile>;
  ingestion: Ingestion;
  signal: AbortSignal;
  paged: boolean;
  capture(): void;
  feeds(): void;
  edit(view: ReaderView, file: TFile): Promise<void>;
  refreshPresentation?(view: ReaderView, valid: () => boolean): Promise<void>;
}
export class ReaderView extends ItemView {
  private queue: Queue = 'Inbox';
  private readingQueue = new ReadingQueue();
  private snapshot?: Snapshot<TFile>;
  private fallbackFile?: TFile;
  private surface?: ReadingSurface;
  private actions?: HTMLElement;
  private status?: HTMLElement;
  private statusMessage?: string;
  private articleTitle?: HTMLElement;
  private presentationKey = '';
  private ownDeferred?: { displayed: string; saved: string };
  private lifetime = new AbortController();
  private articleLifetime = new AbortController();
  private nodeCreationEpoch = 0;
  private indicatorReads = 0;
  private indicatorPump?: () => void;
  private boundaryNavigation = false;
  private nodeCreation?: {
    controller: AbortController;
    source: Snapshot<TFile>;
    writing: boolean;
  };
  private generation = 0;
  private opening = 0;
  private loadingPath?: string;
  private listFrame?: number;
  private selectionTimer?: ReturnType<typeof setTimeout>;
  private selectionRevision = 0;
  private selecting = false;
  private dialog = false;
  private automatic?: Passage;
  private lastSelection = '';
  private writing?: Promise<unknown>;
  private positionWrite: Promise<unknown> = Promise.resolve();
  private operations: Promise<void> = Promise.resolve();
  private operating = false;
  private stopping = false;
  private closing?: Promise<void>;
  private refreshPending = false;
  private listLimit = 50;
  private search = '';
  constructor(
    leaf: WorkspaceLeaf,
    readonly host: ReaderHost,
  ) {
    super(leaf);
    this.navigation = true;
  }
  getViewType(): string {
    return READER_VIEW;
  }
  getDisplayText(): string {
    return this.file ? `Reader: ${this.articleLabel()}` : 'Reading list';
  }
  private articleLabel(): string {
    return this.snapshot
      ? (articleInfo(this.snapshot.path, this.snapshot.properties, this.host.store.folders)
          ?.title ?? this.snapshot.file.basename)
      : (this.fallbackFile?.basename ?? 'Reading list');
  }
  getIcon(): string {
    return 'book-open';
  }
  getState(): Record<string, unknown> {
    return { file: this.file?.path, queue: this.queue };
  }
  async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    // This request-local marker survives host cloning but never enters getState().
    // A delayed title refresh observes current state; it never reopens an old article.
    if (state.readerPresentationOnly === true) {
      result.history = false;
      if (!this.stopping && !this.host.signal.aborted)
        await super.setState(this.getState(), result);
      return;
    }
    if (queues.includes(state.queue as Queue)) this.queue = state.queue as Queue;
    if (typeof state.file === 'string') await this.openArticle(state.file);
    else await this.readingList();
    await super.setState(state, result);
  }
  async onOpen(): Promise<void> {
    const doc = this.containerEl.ownerDocument,
      options = { signal: this.lifetime.signal };
    const pointers = new Set<number>(),
      touches = new Set<number>();
    const release = (event: Event) => {
      if (this.stopping || this.host.signal.aborted) return;
      if (event.type.startsWith('touch')) {
        for (const touch of Array.from((event as TouchEvent).changedTouches ?? []))
          touches.delete(touch.identifier);
      } else pointers.delete((event as PointerEvent).pointerId);
      this.selecting = pointers.size > 0 || touches.size > 0;
      this.selectionChanged();
    };
    doc.addEventListener('selectionchange', () => this.selectionChanged(), options);
    this.contentEl.addEventListener(
      'pointerdown',
      (event) => {
        if (this.stopping || this.host.signal.aborted) return;
        pointers.add(event.pointerId);
        this.selecting = true;
        this.invalidateSelection();
      },
      options,
    );
    for (const type of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'])
      doc.addEventListener(type, release, options);
    doc.defaultView?.addEventListener(
      'blur',
      () => {
        pointers.clear();
        touches.clear();
        this.selecting = false;
        this.selectionChanged();
      },
      options,
    );
    // Stop only workspace swipe recognition, not native selection, scrolling or
    // zoom. Bubble after Surface's capture handlers and Reader's pointerdown.
    const gestures = new AbortController(),
      stopGestures = () => {
        gestures.abort();
        this.invalidateSelection();
      };
    this.lifetime.signal.addEventListener('abort', stopGestures, { once: true });
    this.host.signal.addEventListener('abort', stopGestures, { ...options, once: true });
    if (this.lifetime.signal.aborted || this.host.signal.aborted) stopGestures();
    const isolate = (event: Event) => {
      if (this.stopping || this.host.signal.aborted) return;
      if (
        event.type.startsWith('pointer') &&
        !['touch', 'pen'].includes((event as PointerEvent).pointerType)
      )
        return;
      if (event.type === 'touchstart') {
        for (const touch of Array.from((event as TouchEvent).changedTouches ?? []))
          touches.add(touch.identifier);
        this.selecting = true;
        this.invalidateSelection();
      }
      if (['pointerup', 'pointercancel', 'touchend', 'touchcancel'].includes(event.type))
        release(event); // Document bubble cannot observe this isolated release.
      event.stopPropagation();
    };
    for (const type of [
      'touchstart',
      'touchmove',
      'touchend',
      'touchcancel',
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
    ])
      this.contentEl.addEventListener(type, isolate, {
        passive: true,
        signal: gestures.signal,
      });
    this.contentEl.addEventListener('click', (event) => this.clicked(event), options);
    this.showList();
  }
  onClose(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve();
    if (this.closing) return this.closing;
    const selection = this.surface?.selection(),
      body = this.surface?.displayedBody;
    const pending = selection && body !== undefined ? { selection, body } : undefined;
    this.stopping = true;
    this.articleLifetime.abort();
    if (this.listFrame !== undefined) cancelAnimationFrame(this.listFrame);
    clearTimeout(this.selectionTimer);
    this.closing = (async () => {
      try {
        await this.operations.catch((error) => this.error(error));
        // Normal tab/source transitions can await this. Host plugin unload cannot.
        if (!this.host.signal.aborted) {
          this.selecting = false;
          this.dialog = false;
          await this.prepareToLeave(pending);
        }
      } catch (error) {
        this.error(error);
      } finally {
        this.disposeReading();
      }
    })();
    return this.closing;
  }
  /** Host unload cannot await pending dialogs/I/O; detach UI/listeners immediately. */
  stopForUnload(): void {
    this.stopping = true;
    this.articleLifetime.abort();
    if (this.listFrame !== undefined) cancelAnimationFrame(this.listFrame);
    clearTimeout(this.selectionTimer);
    this.disposeReading();
  }
  private disposeReading(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.generation++;
    this.surface?.dispose();
    this.surface = undefined;
  }
  private operation(action: () => Promise<void>, scoped = true): Promise<void> {
    const generation = this.generation;
    const next = this.operations
      .catch(() => {})
      .then(async () => {
        if (this.stopping || this.host.signal.aborted || (scoped && generation !== this.generation))
          return;
        this.operating = true;
        try {
          await action();
        } finally {
          this.operating = false;
          if (this.refreshPending && !this.stopping) {
            this.refreshPending = false;
            if (this.snapshot)
              void this.changed({ path: this.snapshot.file.path }).catch((error) =>
                this.error(error),
              );
          }
        }
      });
    this.operations = next;
    return next;
  }
  private current(snapshot: Snapshot<TFile>, generation: number): boolean {
    return (
      !this.lifetime.signal.aborted &&
      !this.host.signal.aborted &&
      this.generation === generation &&
      this.snapshot?.file === snapshot.file
    );
  }
  private acceptsSource(
    snapshot: Snapshot<TFile>,
    displayed: string | undefined,
    ownSelection = false,
  ): boolean {
    return (
      displayed !== undefined &&
      (displayed === snapshot.body ||
        (ownSelection &&
          this.ownDeferred?.displayed === displayed &&
          this.ownDeferred.saved === snapshot.body))
    );
  }
  private assertDisplayed(snapshot: Snapshot<TFile>, ownSelection = false): void {
    if (!this.acceptsSource(snapshot, this.surface?.displayedBody, ownSelection))
      throw new Error(
        'Article text changed while Reader preserved your selection. Clear the selection to show current text, or Open Markdown. No stale edit was saved.',
      );
  }
  private adoptSnapshot(snapshot: Snapshot<TFile>): void {
    if (this.snapshot?.body !== snapshot.body) {
      this.automatic = undefined;
      this.lastSelection = '';
    }
    if (this.ownDeferred?.saved !== snapshot.body) this.ownDeferred = undefined;
    this.snapshot = snapshot;
  }
  private syncPresentation(): void {
    const title = this.articleLabel();
    if (this.surface) this.surface.setTitle(title);
    else if (this.articleTitle) this.articleTitle.textContent = title;
    const key = JSON.stringify([this.file?.path, this.queue, title]);
    if (!this.stopping && !this.host.signal.aborted && key !== this.presentationKey) {
      this.presentationKey = key;
      // The host owns native transitions, including this presentation-only request.
      // It drains them before folder replacement or an explicit Markdown escape.
      void this.host
        .refreshPresentation?.(this, () => !this.stopping && !this.lifetime.signal.aborted)
        .catch((error) => this.error(error));
      this.app.workspace.requestSaveLayout();
    }
  }
  private error(error: unknown): void {
    if (!this.host.signal.aborted)
      new Notice(error instanceof Error ? error.message : String(error));
  }
  private button(
    parent: HTMLElement,
    label: string,
    action: () => void | Promise<void>,
    icon?: string,
  ): HTMLButtonElement {
    const button = parent.createEl(
      'button',
      icon ? { cls: 'reader-icon-button' } : { text: label },
    );
    if (icon) {
      setIcon(button, icon);
      setTooltip(button, label);
      button.setAttribute('aria-label', label);
      button.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    }
    button.addEventListener('click', () => {
      // Let the action register navigation intent synchronously, before yielding.
      try {
        void Promise.resolve(action()).catch((error) => this.error(error));
      } catch (error) {
        this.error(error);
      }
    });
    return button;
  }
  private clear(): void {
    clearTimeout(this.selectionTimer);
    this.articleLifetime.abort();
    this.articleLifetime = new AbortController();
    this.surface?.dispose();
    this.surface = undefined;
    this.snapshot = undefined;
    this.fallbackFile = undefined;
    this.actions = undefined;
    this.status = undefined;
    this.statusMessage = undefined;
    this.articleTitle = undefined;
    this.automatic = undefined;
    this.lastSelection = '';
    this.ownDeferred = undefined;
    this.contentEl.empty();
    this.contentEl.addClass('reader-view');
    this.generation++;
  }
  private showFailure(file: TFile, error: unknown): void {
    this.clear();
    this.fallbackFile = file;
    this.articleTitle = this.contentEl.createEl('h1', { cls: 'reader-article-title' });
    this.syncPresentation();
    this.contentEl.createEl('h3', { text: 'Cannot display this article' });
    this.contentEl.createEl('p', {
      text: error instanceof Error ? error.message : String(error),
      attr: { role: 'alert' },
    });
    this.contentEl.createEl('p', {
      text: 'Reader will not edit this file in its current state. Open Markdown to inspect it.',
    });
    this.button(this.contentEl, 'Open Markdown', () => this.openMarkdown(file), 'file-pen-line');
    this.button(this.contentEl, 'Retry Reader', () => this.openArticle(file.path), 'refresh-cw');
    this.button(this.contentEl, 'Back to list', () => this.readingList(), 'list');
  }
  showList(queue = this.queue): void {
    this.clear();
    this.snapshot = undefined;
    this.queue = queue;
    this.syncPresentation();
    const list = this.contentEl.createDiv({ cls: 'reader-list' });
    const tabs = this.contentEl.createEl('nav', {
      cls: 'reader-toolbar reader-bottom-controls',
      attr: { 'aria-label': 'Reading list actions' },
    });
    for (const name of queues.filter((name) => name !== 'Treasury')) {
      const button = this.button(
        tabs,
        name,
        () => {
          this.search = '';
          this.listLimit = 50;
          this.showList(name);
        },
        { Inbox: 'inbox', Stream: 'waves', Later: 'clock' }[name],
      );
      button.classList.toggle('mod-cta', name === queue);
    }
    this.button(tabs, 'Add URL', () => this.host.capture(), 'plus');
    let stopIndicators: (() => void) | undefined;
    const render = () => {
      stopIndicators?.();
      list.empty();
      const visibleRows = new Map<HTMLElement, string>();
      const rows = this.host.store.catalog.list(queue, this.search, 0, this.listLimit + 1);
      for (const article of rows.slice(0, this.listLimit)) {
        const button = this.button(list, '', () => this.openArticle(article.path, true));
        button.addClass('reader-list-item');
        button.createEl('span', { cls: 'reader-list-title', text: article.title });
        visibleRows.set(button, article.path);
      }
      stopIndicators = this.observeRowIndicators(list, visibleRows);
      if (!rows.length) list.createEl('p', { text: 'No articles in this queue.' });
      if (rows.length > this.listLimit)
        this.button(
          list,
          'Show more',
          () => {
            this.listLimit += 50;
            render();
          },
          'chevrons-down',
        );
    };
    render();
  }
  /** Positive-only, visible-row decoration. No catalog scan, promotion or persisted state. */
  private observeRowIndicators(list: HTMLElement, rows: Map<HTMLElement, string>): () => void {
    const Observer = list.ownerDocument.defaultView?.IntersectionObserver;
    if (typeof Observer !== 'function' || !rows.size || this.stopping || this.host.signal.aborted)
      return () => {};
    const signal = this.articleLifetime.signal,
      generation = this.generation;
    const visible = new Set<HTMLElement>(),
      pending = new Map<HTMLElement, string>(),
      reading = new Set<HTMLElement>();
    let closed = false;
    const active = () =>
      !closed &&
      !signal.aborted &&
      !this.host.signal.aborted &&
      !this.stopping &&
      generation === this.generation &&
      list.isConnected;
    const pump = () => {
      while (active() && this.indicatorReads < 2 && pending.size) {
        const [row, path] = pending.entries().next().value!;
        pending.delete(row);
        if (!visible.has(row) || !row.isConnected) continue;
        const file = this.host.store.vault.file(path),
          stat = file?.stat;
        if (!file || !stat) continue;
        const { mtime, size } = stat;
        this.indicatorReads++;
        reading.add(row);
        void (async () => {
          const raw = await this.host.store.vault.read(file);
          if (
            !active() ||
            !visible.has(row) ||
            !row.isConnected ||
            file.path !== path ||
            this.host.store.vault.file(path) !== file ||
            file.stat.mtime !== mtime ||
            file.stat.size !== size
          )
            return;
          const document = readDocument(raw);
          if (document.properties.type !== 'article') return;
          const openedBefore = !!readingMarker(document.properties.reading_position);
          let highlighted = false;
          try {
            highlighted = renderedHighlight(document.body);
          } catch {
            // Uncertain highlight grammar must not erase known position evidence.
          }
          for (const [present, name, icon, label] of [
            [openedBefore, 'reader-opened-indicator', 'eye', 'Opened before'],
            [highlighted, 'reader-highlight-indicator', 'highlighter', 'Has highlights'],
          ] as const) {
            if (!present) continue;
            const indicator = row.createEl('span', {
              cls: `reader-row-indicator ${name}`,
              attr: { role: 'img', 'aria-label': label },
            });
            setIcon(indicator, icon);
            setTooltip(indicator, label);
            indicator.querySelector('svg')?.setAttribute('aria-hidden', 'true');
          }
          observer.unobserve(row);
          rows.delete(row);
          visible.delete(row);
        })()
          .catch(() => {
            // Unknown/unreadable status is not evidence of no highlights. Leave the title alone.
          })
          .finally(() => {
            reading.delete(row);
            this.indicatorReads--;
            this.indicatorPump?.();
          });
      }
    };
    const observer = new Observer(
      (entries) => {
        if (!active()) return;
        for (const entry of entries) {
          const row = entry.target as HTMLElement,
            path = rows.get(row);
          if (!path) continue;
          if (entry.isIntersecting) {
            visible.add(row);
            if (!reading.has(row)) pending.set(row, path);
          } else {
            visible.delete(row);
            pending.delete(row);
          }
        }
        pump();
      },
      { root: list },
    );
    const stop = () => {
      closed = true;
      observer.disconnect();
      pending.clear();
      visible.clear();
      if (this.indicatorPump === pump) this.indicatorPump = undefined;
      signal.removeEventListener('abort', stop);
      this.host.signal.removeEventListener('abort', stop);
    };
    this.indicatorPump = pump;
    signal.addEventListener('abort', stop, { once: true });
    this.host.signal.addEventListener('abort', stop, { once: true });
    for (const row of rows.keys()) observer.observe(row);
    return stop;
  }
  openArticle(path: string, fromList = false, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    this.cancelNodeCreation();
    // Snapshot every matching result at the click, not just the rendered first 50.
    const browsing = fromList
      ? {
          queue: this.queue,
          paths: this.host.store.catalog
            .list(this.queue, this.search, 0, this.host.store.catalog.size)
            .map((article) => article.path),
        }
      : undefined;
    return this.operation(() => this.openArticleNow(path, browsing, signal), false);
  }
  private async openArticleNow(
    path: string,
    browsing?: BrowsingContext,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    const request = ++this.opening;
    this.loadingPath = path;
    let token: number | undefined,
      targetFile = this.host.store.vault.file(path);
    try {
      await this.prepareToLeave();
      if (this.stopping || this.host.signal.aborted || signal?.aborted || request !== this.opening)
        return;
      token = this.generation;
      let snapshot = await this.host.store.read(path);
      if (
        this.stopping ||
        this.lifetime.signal.aborted ||
        this.host.signal.aborted ||
        signal?.aborted ||
        token !== this.generation
      )
        return;
      targetFile = snapshot.file;
      let article = articleInfo(path, snapshot.properties, this.host.store.folders)!;
      const origin =
        browsing ??
        (!this.readingQueue.current
          ? {
              queue: article.queue ?? this.queue,
              paths: article.queue ? this.host.store.catalog.paths(article.queue) : [path],
            }
          : undefined);
      // Fresh Stream articles are not scanned by expiry. Use the body already opened
      // here to preserve native/synced annotations without changing the origin queue.
      if (article.queue === 'Stream' && hasAnnotations(snapshot.body, snapshot.properties)) {
        try {
          snapshot = await this.host.store.move(snapshot, 'Inbox');
        } catch (error) {
          this.error(error);
          // A failed multi-step host move may have changed the path. Never continue
          // with an obsolete snapshot; a failed reread leaves the Markdown escape.
          snapshot = await this.host.store.read(snapshot.file.path);
        }
        if (
          this.stopping ||
          this.host.signal.aborted ||
          signal?.aborted ||
          token !== this.generation
        )
          return;
        article = articleInfo(snapshot.path, snapshot.properties, this.host.store.folders)!;
      }
      // Keep the old article and browsing context until all awaited work and modal
      // cancellation checks finish. A cancelled capture cannot steal the current view.
      this.clear();
      token = this.generation;
      this.snapshot = snapshot;
      if (origin) {
        this.queue = origin.queue;
        const paths = origin.paths.map((item) => (item === path ? snapshot.path : item));
        this.readingQueue.open(
          paths.includes(snapshot.path) ? paths : [...paths, snapshot.path],
          snapshot.path,
        );
      } else {
        this.readingQueue.rename(path, snapshot.path);
        this.readingQueue.select(snapshot.path);
      }
      const column = this.contentEl.createDiv({ cls: 'reader-article' });
      const surface = new ReadingSurface(
        column,
        this.host.paged,
        (marker) => this.persistPosition(marker),
        (error) => {
          if (this.current(snapshot, token!) && !this.stopping)
            this.showFailure(snapshot.file, error);
        },
      );
      this.surface = surface;
      this.articleTitle = surface.title;
      this.syncPresentation();
      surface.setBody(snapshot.body, article.url);
      if (this.surface !== surface) return; // The synchronous error callback installed the escape hatch.
      surface.restore(readingMarker(snapshot.properties.reading_position) ?? '');
      if (this.surface !== surface) return;
      this.status = column.createDiv({ cls: 'reader-status', attr: { role: 'status' } });
      column.prepend(this.status); // Feedback stays clear of the floating controls.
      this.actions = column.createEl('nav', {
        cls: 'reader-actions reader-bottom-controls',
        attr: { 'aria-label': 'Article actions' },
      });
      this.controls();
      if (article.url)
        void this.host.ingestion.acquire(snapshot.path, true).catch((error) => this.error(error));
    } catch (error) {
      if (signal?.aborted) return;
      // A failed save before leaving must keep the current selection/article intact.
      if (
        token !== undefined &&
        token === this.generation &&
        request === this.opening &&
        !this.stopping &&
        !this.host.signal.aborted
      ) {
        const file = targetFile ?? this.host.store.vault.file(path);
        if (file) {
          this.showFailure(file, error);
          return;
        }
        this.showList();
      }
      throw error;
    } finally {
      if (request === this.opening) this.loadingPath = undefined;
    }
  }
  private controls(): void {
    if (!this.snapshot || !this.actions || !this.surface) return;
    this.syncPresentation();
    this.actions.empty();
    for (const [label, direction] of [
      ['Previous', -1],
      ['Next', 1],
    ] as const) {
      const button = this.button(
        this.actions,
        label,
        () => {
          if (this.surface?.canPage(direction)) {
            this.surface.page(direction); // Paging is not article-navigation intent.
            this.controls();
            return;
          }
          return direction === 1 ? this.finish('next') : this.navigate(-1);
        },
        direction === -1 ? 'chevron-left' : 'chevron-right',
      );
      button.disabled =
        direction === -1 &&
        !this.surface.canPage(-1) &&
        !this.readingQueue.neighbour(-1, (path) => !!this.host.store.catalog.article(path));
      button.setAttribute(
        'aria-label',
        this.host.paged ? `${label} page or article` : `${label} article`,
      );
    }
    this.button(this.actions, 'Read later', () => this.move('Later'), 'clock');
    this.button(
      this.actions,
      'Save to Treasury',
      () => this.finish('keep'),
      'bookmark',
    ).setAttribute('aria-label', 'Save to Treasury and advance');
    this.button(this.actions, 'Delete', () => this.finish('delete'), 'trash-2').setAttribute(
      'aria-label',
      'Trash article and advance',
    );
    this.button(this.actions, 'List', () => this.readingList(), 'list');
    this.updateStatus();
  }
  private updateStatus(): void {
    if (!this.snapshot || !this.status) return;
    const article = articleInfo(
      this.snapshot.path,
      this.snapshot.properties,
      this.host.store.folders,
    )!;
    const message =
      article.error ||
      (!this.snapshot.body.trim()
        ? 'Article text is pending. Reader will fetch it while online and active.'
        : '');
    if (message === this.statusMessage) return;
    this.statusMessage = message;
    this.status.textContent = message;
    if (article.error)
      this.button(
        this.status,
        'Retry',
        () => this.host.ingestion.acquire(this.snapshot!.file.path, true),
        'refresh-cw',
      );
  }
  private invalidateSelection(): number {
    clearTimeout(this.selectionTimer);
    this.selectionTimer = undefined;
    return ++this.selectionRevision;
  }
  private selectionChanged(): void {
    if (this.stopping || this.host.signal.aborted) return;
    const revision = this.invalidateSelection();
    const selection = this.surface?.selection();
    if (!selection) {
      this.automatic = undefined;
      this.lastSelection = '';
      this.surface?.refresh();
      this.updateStatus();
      return;
    }
    this.updateStatus();
    const surface = this.surface,
      source = this.snapshot,
      generation = this.generation;
    if (
      !this.selecting &&
      !this.dialog &&
      surface &&
      !surface.pointerActive &&
      source &&
      surface.displayedBody !== undefined
    ) {
      // Snapshot text, not the live native Range. An old timer/queued action cannot
      // acquire a different selection merely because an operation or position write waited.
      const pending: PendingSelection = {
        selection: { quote: selection.quote, before: selection.before, after: selection.after },
        body: surface.displayedBody,
      };
      const valid = () => {
        if (
          this.stopping ||
          this.selecting ||
          surface.pointerActive ||
          this.dialog ||
          this.selectionRevision !== revision ||
          this.surface !== surface ||
          !this.current(source, generation) ||
          surface.displayedBody !== pending.body ||
          !this.acceptsSource(this.snapshot!, pending.body, true)
        )
          return false;
        // Native selectionchange can itself be queued: check the current text too.
        const live = surface.selection();
        return (
          live?.quote === pending.selection.quote &&
          live.before === pending.selection.before &&
          live.after === pending.selection.after
        );
      };
      // Require 900ms of quiet after the last adjustment/release; never
      // write while a pointer is held. Tokens still guard every asynchronous boundary.
      this.selectionTimer = setTimeout(() => {
        void this.operation(async () => {
          try {
            await this.saveSelection(pending, valid);
          } catch (error) {
            if (!(error instanceof UnmappableSelection)) throw error;
          }
        }).catch((error) => this.error(error));
      }, 900);
    }
  }
  private async saveSelection(
    pending?: PendingSelection,
    valid: () => boolean = () => true,
  ): Promise<void> {
    await this.positionWrite;
    if (!valid()) return;
    const selection = pending?.selection ?? this.surface?.selection(),
      snapshot = this.snapshot;
    if (!selection || !snapshot || this.selecting || this.surface?.pointerActive || this.dialog)
      return;
    const key = JSON.stringify([selection.quote, selection.before, selection.after]);
    if (key === this.lastSelection) return;
    if (this.writing) {
      await this.writing;
      return this.saveSelection(pending, valid);
    }
    this.assertDisplayed(snapshot, true);
    const displayed = pending?.body ?? this.surface!.displayedBody!;
    if (!this.acceptsSource(snapshot, displayed, true))
      throw new Error('The displayed article changed before the closing selection could be saved.');
    const generation = this.generation,
      previous = this.automatic;
    let body = snapshot.body;
    // Adjust only overlapping selections. Selecting the same words elsewhere must
    // add a second highlight, not relocate the already-saved automatic one.
    if (previous) {
      const unmarked = changePassage(body, previous, 'remove');
      const candidate = locateSelection(
        unmarked,
        selection.quote,
        selection.before,
        selection.after,
      );
      if (candidate.from < previous.from + previous.text.length && candidate.to > previous.from)
        body = unmarked;
    }
    const range = locateSelection(body, selection.quote, selection.before, selection.after);
    const next = addHighlight(body, range.from, range.to);
    // Transient paint only: PendingSelection remains immutable text/source authority.
    // Capture after timer/position waits so the selectionchange event has finished.
    const feedbackSurface = this.surface,
      nativeRange = feedbackSurface?.selection()?.range,
      acknowledge =
        !this.stopping && nativeRange ? feedbackSurface?.highlightFeedback(nativeRange) : undefined;
    const superseded = new Error('The selection changed before the highlight was saved.');
    const promise = this.host.store
      .annotate(snapshot, (raw) => {
        if (!valid()) throw superseded;
        if (!this.current(snapshot, generation))
          throw new Error('The article changed before the highlight was saved.');
        this.assertDisplayed(snapshot, true);
        if (!this.acceptsSource(snapshot, displayed, true))
          throw new Error('The selected source is no longer current.');
        return replaceBody(raw, snapshot.body, next);
      })
      .catch((error) => {
        // Expected supersession is a cancelled automatic action, not a failed disk write.
        if (error !== superseded) throw error;
      });
    this.writing = promise;
    try {
      const saved = await promise;
      if (!saved || !this.current(snapshot, generation)) return;
      this.snapshot = saved;
      this.automatic = passages(next).find((item) => item.from === range.from);
      this.lastSelection = key;
      // Only our own byte-guarded automatic markup may bridge a deferred repaint.
      // External snapshots, passage edits and arbitrary equal-looking text get no exception.
      this.ownDeferred = { displayed, saved: saved.body };
      this.surface?.setBody(next, text(saved.properties.url));
      if (this.surface?.displayedBody === next) this.ownDeferred = undefined;
      this.controls();
      if (
        !this.stopping &&
        this.surface === feedbackSurface &&
        saved.body === next &&
        next !== snapshot.body
      )
        acknowledge?.();
    } finally {
      if (this.writing === promise) this.writing = undefined;
    }
  }
  private persistPosition(marker: string): void {
    const snapshot = this.snapshot,
      generation = this.generation;
    const displayed = this.surface?.displayedBody;
    if (!snapshot || this.host.signal.aborted || !this.acceptsSource(snapshot, displayed, true))
      return;
    this.positionWrite = this.positionWrite
      .catch(() => {})
      .then(async () => {
        if (
          !this.current(snapshot, generation) ||
          !this.acceptsSource(this.snapshot!, displayed, true) ||
          this.host.store.vault.file(snapshot.file.path) !== snapshot.file
        )
          return;
        const before = this.snapshot;
        const saved = await this.host.store.position(snapshot.file.path, marker);
        if (this.current(snapshot, generation)) {
          if (saved.file !== snapshot.file) {
            this.showFailure(
              saved.file,
              new Error('The article file was replaced. Reopen it before continuing.'),
            );
            return;
          }
          if (this.snapshot === before) {
            this.adoptSnapshot(saved);
            this.surface?.setBody(saved.body, text(saved.properties.url));
            this.syncPresentation();
          } else {
            this.refreshPending = true;
            if (!this.operating)
              void this.changed({ path: snapshot.file.path }).catch((error) => this.error(error));
          }
        }
      })
      .catch((error) => this.error(error));
  }
  private async prepareToLeave(pending?: PendingSelection): Promise<void> {
    clearTimeout(this.selectionTimer);
    await this.positionWrite;
    await this.saveSelection(pending);
    await this.writing;
    this.surface?.flush();
    await this.positionWrite;
  }
  flush(): Promise<void> {
    return this.operation(() => this.prepareToLeave(), false);
  }
  /** Public palette route. Checking availability must never cancel a live Nodes request. */
  articleCommand(command: 'move' | 'topics' | 'open-markdown', checking: boolean): boolean {
    if (
      this.stopping ||
      this.host.signal.aborted ||
      !this.file ||
      (command !== 'open-markdown' && !this.snapshot)
    )
      return false;
    if (!checking) {
      const task =
        command === 'move'
          ? this.move()
          : command === 'topics'
            ? this.topics()
            : this.openMarkdown(this.file);
      void task.catch((error) => this.error(error));
    }
    return true;
  }
  private openMarkdown(file: TFile): Promise<void> {
    this.cancelNodeCreation();
    return this.host.edit(this, file);
  }
  prepareMarkdown(): Promise<void> {
    this.cancelNodeCreation();
    return this.operation(async () => {
      const file = this.file;
      try {
        await this.positionWrite;
        if (
          this.snapshot &&
          (await this.host.store.read(this.snapshot.file.path)).raw !== this.snapshot.raw
        )
          throw new Error('The file changed outside Reader. Pending selection was not saved.');
        await this.prepareToLeave();
      } catch (error) {
        // An explicit editor escape must not be held hostage by malformed/stale Reader state.
        if (file && this.host.store.vault.file(file.path) === file) this.showFailure(file, error);
        this.error(error);
      }
    }, false);
  }
  readingList(queue?: Queue): Promise<void> {
    this.cancelNodeCreation();
    return this.operation(async () => {
      await this.prepareToLeave();
      if (!this.stopping) {
        if (queue !== undefined) {
          this.search = '';
          this.listLimit = 50;
        }
        this.showList(queue);
      }
    }, false);
  }
  navigate(direction: -1 | 1): Promise<void> {
    this.cancelNodeCreation();
    return this.operation(async () => {
      await this.prepareToLeave();
      const next = this.readingQueue.neighbour(
        direction,
        (path) => !!this.host.store.catalog.article(path),
      );
      if (next) await this.openArticleNow(next);
    }, false);
  }
  private finish(action: 'keep' | 'next' | 'delete'): Promise<void> {
    this.cancelNodeCreation();
    return this.operation(async () => {
      await this.prepareToLeave();
      const snapshot = this.snapshot,
        generation = this.generation;
      if (!snapshot || this.stopping) return;
      this.assertDisplayed(snapshot, true);
      const next = this.readingQueue.neighbour(
        1,
        (path) => !!this.host.store.catalog.article(path),
      );
      if (action === 'keep') await this.host.store.move(snapshot, 'Treasury');
      else if (action === 'delete') await this.host.store.trash(snapshot);
      if (!this.current(snapshot, generation) || this.stopping) return;
      this.snapshot = undefined;
      this.surface?.dispose();
      this.surface = undefined;
      if (next) await this.openArticleNow(next);
      else this.showList();
    });
  }
  private move(destination?: Queue): Promise<void> {
    this.cancelNodeCreation();
    return this.operation(async () => {
      await this.prepareToLeave();
      const snapshot = this.snapshot,
        generation = this.generation;
      if (!snapshot || this.stopping) return;
      const signal = this.articleLifetime.signal;
      const target =
        destination ??
        (await choose(this.app, 'Move article to…', [...queues], (queue) => queue, signal));
      if (!target || signal.aborted || !this.current(snapshot, generation)) return;
      this.assertDisplayed(snapshot, true);
      const moved = await this.host.store.move(snapshot, target);
      if (!this.current(snapshot, generation) || this.stopping) return;
      this.snapshot = moved;
      this.controls();
      if (target === 'Inbox' || target === 'Later')
        void this.host.ingestion.acquire(moved.path).catch((error) => this.error(error));
    });
  }
  private topics(): Promise<void> {
    this.cancelNodeCreation();
    return this.operation(async () => {
      await this.prepareToLeave();
      const snapshot = this.snapshot,
        generation = this.generation;
      if (!snapshot || this.stopping) return;
      const signal = this.articleLifetime.signal;
      const files = this.app.vault
        .getMarkdownFiles()
        .filter((file) => this.app.metadataCache.getFileCache(file)?.frontmatter?.type === 'topic');
      this.assertDisplayed(snapshot, true);
      const stored = snapshot.properties.topics;
      if (stored !== undefined && !Array.isArray(stored))
        throw new Error(
          'Topics contains unrecognized data. Edit it in Markdown; Reader has not changed it.',
        );
      const originals = (stored ?? []).map((value) => {
        const link = linkPath(text(value));
        const file = link
          ? this.app.metadataCache.getFirstLinkpathDest(link, snapshot.file.path)
          : null;
        if (!link || !file || !files.includes(file))
          throw new Error(
            'An existing topic is unresolved or is not a topic note. Edit it in Markdown; Reader has not changed it.',
          );
        return { value, link, file, path: file.path };
      });
      const selected = await chooseTopics(
        this.app,
        files,
        new Set(originals.map((original) => original.path)),
        signal,
      );
      if (selected === null || signal.aborted || !this.current(snapshot, generation)) return;
      await this.positionWrite;
      if (signal.aborted || !this.current(snapshot, generation)) return;
      const base = this.snapshot!;
      if (
        base.body !== snapshot.body ||
        JSON.stringify(base.properties.topics) !== JSON.stringify(stored)
      )
        throw new Error('The article or topics changed while the picker was open. Reopen Topics.');
      const targets = selected.map((path) => ({
        path,
        file: files.find((file) => file.path === path),
      }));
      const saved = await this.host.store.annotate(base, (raw) => {
        if (signal.aborted || !this.current(snapshot, generation))
          throw new Error('The article changed; reopen Topics.');
        this.assertDisplayed(base, true);
        for (const { path, file } of targets) {
          if (
            !file ||
            file.path !== path ||
            this.host.store.vault.file(path) !== file ||
            this.app.metadataCache.getFileCache(file)?.frontmatter?.type !== 'topic'
          )
            throw new Error('A topic changed; reopen the picker.');
        }
        const retained = originals.filter((original) => selected.includes(original.path));
        for (const original of retained) {
          if (
            this.app.metadataCache.getFirstLinkpathDest(original.link, snapshot.file.path) !==
            original.file
          )
            throw new Error('An existing topic link changed meaning. Reopen Topics.');
        }
        const values = [
          ...retained.map((original) => original.value),
          ...selected
            .filter((path) => !retained.some((original) => original.path === path))
            .map(vaultLink),
        ];
        return patchProperties(raw, { topics: values.length ? values : undefined });
      });
      if (!this.current(snapshot, generation) || this.stopping) return;
      this.snapshot = saved;
      this.controls();
    });
  }
  private async openLinked(target: string, newLeaf = false): Promise<void> {
    const snapshot = this.snapshot,
      generation = this.generation;
    if (!snapshot) return;
    this.cancelNodeCreation();
    await this.flush();
    if (!this.stopping && this.current(snapshot, generation))
      await openExistingNote(this.app, target, this.snapshot!.file.path, newLeaf);
  }
  private targetGuard(path: string, api?: NodesApi, type?: string): () => void {
    const file = this.host.store.vault.file(path);
    return () => {
      if (!file || file.path !== path || this.host.store.vault.file(path) !== file)
        throw new Error('The selected note changed or was deleted. Reopen the picker.');
      if (
        api &&
        (nodesApi(this.app) !== api ||
          type === undefined ||
          !api.getNode(path)?.classes.includes(type))
      )
        throw new Error('The selected node or Nodes API changed. Reopen the picker.');
    };
  }
  private clicked(event: MouseEvent): void {
    const element = event.target instanceof Element ? event.target : undefined;
    const mark = element?.closest('mark');
    if (mark && this.surface?.body.contains(mark) && this.snapshot && !this.surface.selection()) {
      try {
        this.assertDisplayed(this.snapshot);
      } catch (error) {
        event.preventDefault();
        this.error(error);
        return;
      }
      const marks = [...this.surface.body.querySelectorAll('mark')],
        source = passages(this.snapshot.body);
      if (marks.length !== source.length) {
        event.preventDefault();
        this.error(
          new Error(
            'This highlight contains unsupported formatting. Use Open Markdown to edit it safely.',
          ),
        );
        return;
      }
      const passage = source[marks.indexOf(mark as HTMLElement)];
      if (!passage) return;
      event.preventDefault();
      this.passageMenu(passage, event);
      return;
    }
    const link = element?.closest<HTMLAnchorElement>('a[href]');
    if (!link || !this.surface?.body.contains(link)) return;
    event.preventDefault();
    const href = link.getAttribute('href')!;
    if (href.startsWith('#')) {
      let id: string;
      try {
        id = decodeURIComponent(href.slice(1));
      } catch {
        return;
      }
      const target = [...this.surface.body.querySelectorAll<HTMLElement>('[id]')].find(
        (element) => element.id === id,
      );
      if (target) this.surface.reveal(target);
    } else if (link.classList.contains('internal-link')) {
      const target = nativeLinkPath(href);
      if (!target) {
        this.error(new Error('This is not a safe vault-note link.'));
        return;
      }
      void this.openLinked(target, event.ctrlKey || event.metaKey).catch((error) =>
        this.error(error),
      );
    } else if (/^https?:/i.test(href)) {
      this.cancelNodeCreation();
      const signal = this.articleLifetime.signal,
        source = this.snapshot,
        surface = this.surface,
        generation = this.generation;
      if (!source) return;
      confirmWebLink(
        this.app,
        href,
        async (modalSignal) => {
          const guard = () => {
            if (
              signal.aborted ||
              modalSignal.aborted ||
              this.stopping ||
              !this.current(source, generation) ||
              this.surface !== surface ||
              this.snapshot?.body !== source.body ||
              this.host.store.vault.file(source.file.path) !== source.file
            )
              throw new Error('Reader capture was cancelled.');
            this.assertDisplayed(source);
          };
          guard();
          const file = await this.host.store.capture({ url: href }, new Date(), guard);
          guard();
          const snapshot = await this.host.store.read(file.path);
          guard();
          const saved =
            queueAt(snapshot.path, this.host.store.folders) === 'Inbox'
              ? snapshot
              : await this.host.store.move(snapshot, 'Inbox', guard);
          guard();
          // Save/capture stays in the current article and its original browsing context.
          void this.host.ingestion.acquire(saved.path, true).catch((error) => {
            if (!signal.aborted) this.error(error);
          });
          new Notice('Saved to Inbox.');
        },
        [signal, this.host.signal],
      );
    }
  }
  private passageMenu(passage: Passage, event: MouseEvent): void {
    if (!this.snapshot) return;
    this.assertDisplayed(this.snapshot);
    const menu = new Menu(),
      snapshot = this.snapshot!,
      signal = this.articleLifetime.signal,
      generation = this.generation;
    const apply = async (
      action: 'remove' | 'unlink' | 'link',
      target?: string,
      validate: () => void = () => {},
      requireCommit = false,
    ) => {
      await this.positionWrite;
      if (signal.aborted || !this.current(snapshot, generation) || this.stopping) {
        if (requireCommit) throw new Error('The article changed or linking was cancelled.');
        return;
      }
      const base = this.snapshot!;
      if (base.body !== snapshot.body)
        throw new Error('The article text changed; reopen the highlight menu.');
      const saved = await this.host.store.annotate(base, (raw) => {
        if (signal.aborted || !this.current(snapshot, generation) || this.stopping)
          throw new Error('The article changed; reopen the highlight menu.');
        this.assertDisplayed(base);
        validate(); // Runs again inside vault.process, not just when the picker closes.
        return replaceBody(
          raw,
          snapshot.body,
          changePassage(snapshot.body, passage, action, target),
        );
      });
      if (signal.aborted || !this.current(snapshot, generation) || this.stopping) {
        if (requireCommit)
          throw new Error('The article changed while linking. Check the saved Markdown.');
        return;
      }
      this.snapshot = saved;
      this.surface?.setBody(saved.body, text(saved.properties.url));
      this.controls();
      return saved;
    };
    const action = (
      label: string,
      run: (epoch: number) => void | Promise<unknown>,
      serialize = true,
    ) =>
      menu.addItem((item) =>
        item.setTitle(label).onClick(() => {
          // A new passage action supersedes the pending Nodes dialog before queuing.
          // Capture creation's epoch at the click, after cancelling any older request.
          this.cancelNodeCreation();
          const epoch = this.nodeCreationEpoch;
          const invoke = async () => {
            if (!signal.aborted && this.current(snapshot, generation)) await run(epoch);
          };
          void (serialize ? this.operation(invoke) : invoke()).catch((error) => this.error(error));
        }),
      );
    const api = nodesApi(this.app);
    if (passage.target) action('Open note', () => this.openLinked(passage.target!), false);
    if (api?.pickNodeForLink) {
      const pick = async (creationEpoch: number) => {
        if (creationEpoch !== this.nodeCreationEpoch) return;
        this.dialog = true;
        const request = { controller: new AbortController(), source: snapshot, writing: false };
        this.nodeCreation = request;
        const abort = () => request.controller.abort();
        for (const lifetime of [signal, this.host.signal]) {
          if (lifetime.aborted) abort();
          else lifetime.addEventListener('abort', abort, { once: true });
        }
        let settleCancellation!: () => void;
        const cancelled = new Promise<undefined>((resolve) => {
          settleCancellation = () => resolve(undefined);
          if (request.controller.signal.aborted) settleCancellation();
          else
            request.controller.signal.addEventListener('abort', settleCancellation, { once: true });
        });
        let acceptingLink = true,
          attemptedLink = false;
        let pendingLink: Promise<void> | undefined;
        const checkCallback = () => {
          if (!acceptingLink) throw new Error('The node creation request has finished.');
          if (request.controller.signal.aborted)
            throw new Error('The node creation request was cancelled.');
        };
        const commitLink = async (node: NodeResult) => {
          checkCallback();
          if (attemptedLink) throw new Error('The node creation callback already ran.');
          attemptedLink = true;
          const validate = this.targetGuard(node.path, api, node.type);
          // Already inside this action's operation: re-enqueueing would deadlock Nodes.
          // Metadata echoes during our write/render must not cancel required completion.
          request.writing = true;
          try {
            const saved = await apply(
              'link',
              node.path,
              () => {
                checkCallback();
                validate();
              },
              true,
            );
            if (!saved) throw new Error('The node link was not committed.');
            request.source = saved;
          } finally {
            request.writing = false;
          }
          await this.checkNodeCreation();
          checkCallback();
        };
        const link = (node: NodeResult): Promise<void> => {
          const result = commitLink(node);
          if (!pendingLink) {
            pendingLink = result;
            // Observe failure immediately even if a provider fails to await its callback.
            void pendingLink.catch(() => {});
          }
          return result;
        };
        try {
          if (nodesApi(this.app) !== api)
            throw new Error('The Nodes API changed. Reopen the menu.');
          this.assertDisplayed(snapshot);
          checkCallback();
          const options = {
            suggestedTitle: passage.text.length <= 80 ? passage.text : undefined,
            sourcePath: snapshot.path,
            signal: request.controller.signal,
          };
          // The shared picker awaits our commit before required completion. Never link
          // again from its return value or prune a created/partially filled note.
          // Race cancellation so an uncooperative provider cannot block navigation.
          await Promise.race([api.pickNodeForLink!(options, link), cancelled]);
        } finally {
          acceptingLink = false;
          signal.removeEventListener('abort', abort);
          this.host.signal.removeEventListener('abort', abort);
          request.controller.signal.removeEventListener('abort', settleCancellation);
          if (this.nodeCreation === request) this.nodeCreation = undefined;
          this.dialog = false;
          // Drain only our own dispatched write, never an uncooperative provider dialog.
          // Closing the callback scope first also rejects a premature provider return.
          await pendingLink;
        }
      };
      action(passage.target ? 'Change link…' : 'Link to note…', pick);
      action('Create note…', pick);
    }
    menu.addSeparator();
    if (passage.target) action('Remove link (keeps highlight)', () => apply('unlink'));
    action('Remove highlight', () => apply('remove'));
    menu.showAtMouseEvent(event);
  }
  private cancelNodeCreation(): void {
    // Explicit navigation/action intent only, never save/render/position/background flush.
    // Run before entering the operation queue that Nodes currently occupies.
    this.nodeCreationEpoch++;
    this.nodeCreation?.controller.abort();
  }
  /** Validate only the active Nodes request, independently of its occupied operation queue.
   * Never await positionWrite here: this can run inside that write's metadata notification. */
  private async checkNodeCreation(): Promise<void> {
    const request = this.nodeCreation;
    if (!request || request.writing || request.controller.signal.aborted) return;
    const source = request.source;
    const stillCurrent = () =>
      this.nodeCreation === request && !request.writing && request.source === source;
    if (
      source.file.path !== source.path ||
      this.host.store.vault.file(source.path) !== source.file
    ) {
      request.controller.abort();
      return;
    }
    try {
      const current = await this.host.store.read(source.path);
      if (
        stillCurrent() &&
        (current.file !== source.file ||
          current.path !== source.path ||
          current.body !== source.body)
      )
        request.controller.abort();
    } catch {
      if (stillCurrent()) request.controller.abort();
    }
  }
  async changed(change: LibraryChange): Promise<void> {
    if (this.stopping || this.lifetime.signal.aborted || this.host.signal.aborted) return;
    const request = this.nodeCreation;
    if (request) {
      const source = request.source;
      if (
        change.path === source.path ||
        change.path === source.file.path ||
        change.previousPath === source.path
      ) {
        if (change.deleted && !request.writing) request.controller.abort();
        else await this.checkNodeCreation();
      }
    }
    if (change.previousPath) this.readingQueue.rename(change.previousPath, change.path);
    if (this.loadingPath) {
      if (
        this.snapshot &&
        (this.snapshot.file.path === change.path || this.snapshot.path === change.previousPath)
      )
        this.refreshPending = true;
      return;
    }
    if (!this.snapshot) {
      if (this.fallbackFile) {
        if (change.deleted && this.fallbackFile.path === change.path) this.showList();
        return;
      }
      // Batch arriving feeds and leave a focused search input untouched.
      if (change.metadataChanged && this.listFrame === undefined)
        this.listFrame = requestAnimationFrame(() => {
          this.listFrame = undefined;
          if (
            !this.snapshot &&
            !this.loadingPath &&
            !this.lifetime.signal.aborted &&
            this.contentEl.ownerDocument.activeElement?.tagName !== 'INPUT'
          )
            this.showList();
        });
      return;
    }
    if (this.snapshot.file.path !== change.path) return;
    if (this.operating || this.writing) {
      this.refreshPending = true;
      return;
    }
    if (change.deleted || !this.host.store.vault.file(change.path)) {
      this.showList();
      return;
    }
    const before = this.snapshot,
      generation = this.generation;
    try {
      const current = await this.host.store.read(change.path);
      if (this.stopping || !this.current(before, generation) || this.snapshot !== before) return;
      if (this.operating || this.writing) {
        this.refreshPending = true;
        return;
      }
      if (current.file !== before.file) {
        this.showFailure(
          current.file,
          new Error('The article file was replaced. Reopen it before continuing.'),
        );
        return;
      }
      this.adoptSnapshot(current);
      this.surface?.setBody(current.body, text(current.properties.url));
      this.controls();
    } catch (error) {
      if (!this.stopping && this.current(before, generation)) {
        if (this.operating || this.writing) this.refreshPending = true;
        else this.showFailure(before.file, error);
      }
    }
  }
  key(event: KeyboardEvent): void {
    if (
      this.stopping ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      !this.snapshot ||
      !this.surface ||
      this.dialog ||
      this.containerEl.ownerDocument.getSelection()?.isCollapsed === false
    )
      return;
    if (
      (event.target as Element | null)?.closest?.(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),.modal,.menu',
      ) ||
      this.containerEl.ownerDocument.querySelector('.modal-container,.menu')
    )
      return;
    const direction = ['ArrowDown', 'PageDown'].includes(event.key)
      ? 1
      : ['ArrowUp', 'PageUp'].includes(event.key)
        ? -1
        : undefined;
    if (direction && this.surface.atBoundary(direction)) {
      if (event.repeat || this.boundaryNavigation) return;
      event.preventDefault();
      this.boundaryNavigation = true;
      void (direction === 1 ? this.finish('next') : this.navigate(-1))
        .catch((error) => this.error(error))
        .finally(() => {
          this.boundaryNavigation = false;
        });
    } else if (this.host.paged && direction) {
      event.preventDefault();
      this.surface?.page(direction);
      this.controls();
    } else if (['j', 'k'].includes(event.key)) {
      event.preventDefault();
      void this.navigate(event.key === 'j' ? 1 : -1).catch((error) => this.error(error));
    }
  }
  protects(file: TFile): boolean {
    return this.file === file || this.loadingPath === file.path;
  }
  get file(): TFile | undefined {
    return this.snapshot?.file ?? this.fallbackFile;
  }
  get busy(): boolean {
    return this.operating || !!this.writing || this.selecting || !!this.surface?.selection();
  }
}
