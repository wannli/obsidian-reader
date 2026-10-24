import {
  ItemView,
  Notice,
  Platform,
  parseLinktext,
  setIcon,
  setTooltip,
  type App,
  TFile,
  type ViewStateResult,
  type WorkspaceLeaf,
} from 'obsidian';
import {
  changePassage,
  locateSelection,
  passages,
  UnmappableSelection,
  type Passage,
} from '../core/annotations';
import { ReadingQueue } from '../core/catalog';
import { matchesTopicArticle, type TopicFilter } from '../core/topic-filter';
import { chooseTopicFilter } from '../host/topic-filter-dialog';
import { TopicScanner } from './topic-scan';
import { readDocument, readingMarker, replaceBody } from '../core/document';
import { IndicatorReadSlots, RowIndicators } from './row-indicators';
import { ListRows } from './list-rows';
import { SelectionCoordinator } from './selection-coordinator';
import { nativeLinkPath, openExistingNote } from '../host/note-links';
export { nativeLinkPath, openExistingNote } from '../host/note-links';
import { articleInfo, linkPath, queues, text, type Queue } from '../core/model';
import {
  PartialCollectionError,
  type ArticleStore,
  type HighlightCollectionPhase,
  type Snapshot,
} from '../core/store';
import {
  convertPassage,
  hostSelection,
  mentionSelection,
  hostPassage,
  passageHosts,
  replacePassageHosts,
  type HostedHighlight,
} from '../core/hosted-highlights';
import { choose, confirmWebLink } from '../host/dialogs';
import type { Ingestion } from '../host/ingestion';
import { nodesApi, type NodesApi, type NodeResult } from '../host/nodes';
import { chooseHighlightHost } from '../host/highlight-picker';
import { hasNodeClass } from '../core/node-choices';
import type { LibraryChange } from '../host/vault';
import { ReadingSurface } from './surface';
import { selectedPassage, selectionRange } from './render';
import { TapHighlighter, type TapToolbarAction } from './tap-highlighter';

export const READER_VIEW = 'obsidian-reader';
export interface ReaderState {
  file?: string;
  queue?: Queue;
  /** Incoming native block navigation only; intentionally omitted from getState(). */
  subpath?: string;
}
type PendingSelection = {
  readonly selection: Readonly<
    Pick<NonNullable<ReturnType<ReadingSurface['selection']>>, 'quote' | 'before' | 'after'>
  >;
  readonly body: string;
};
type BrowsingContext = { queue: Queue; paths: string[]; filtered?: boolean };
type HighlightRemoval = {
  paths: string[];
  previousQuote: Pick<HostedHighlight, 'quoteMarkdown' | 'blockId'>;
  validate: (paths?: readonly string[]) => void;
};
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
  private tapHighlighter?: TapHighlighter;
  private passageActions?: readonly TapToolbarAction[];
  private passageIntent = 0;
  private sendSource?: {
    snapshot: Snapshot<TFile>;
    passage: Passage;
    generation: number;
    draft: NodeResult[];
    mode: 'selected' | 'explicit';
  };
  private tapMode = false;
  private tapKind: 'highlight' | 'node' = 'highlight';
  private tapUndo?: { snapshot: Snapshot<TFile>; before: string; passage: Passage };
  private tapUndoUntil = 0;
  private tapUndoTimer?: ReturnType<typeof setTimeout>;
  private actions?: HTMLElement;
  private status?: HTMLElement;
  private statusMessage?: string;
  private articleTitle?: HTMLElement;
  private presentationKey = '';
  private ownDeferred?: { displayed: string; saved: string };
  private lifetime = new AbortController();
  private articleLifetime = new AbortController();
  private nodeCreationEpoch = 0;
  private topicAssignment?: AbortController;
  private indicatorSlots = new IndicatorReadSlots();
  private rowIndicators?: RowIndicators<TFile>;
  private mountedListRows?: ListRows;
  private refreshList?: () => void;
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
  private selectionState = new SelectionCoordinator();
  private get selecting(): boolean {
    return this.selectionState.selecting;
  }
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
  private listSelectedPath?: string;
  private focusSelectedListRow = false;
  private pendingG = 0;
  private shortcutHelp?: HTMLElement;
  private shortcutHelpReturn?: HTMLElement;
  private search = '';
  private topicFilter?: TopicFilter;
  /** Only an article reached through a filtered browsing snapshot carries this origin. */
  private filteredOrigin = false;
  private filteredPaths: string[] = [];
  private topicScan?: AbortController;
  private topicScanner = new TopicScanner();
  private topicPicker?: AbortController;
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
    return this.file ? `Reader: ${this.articleLabel()}` : this.listLabel();
  }
  private listLabel(): string {
    return this.topicFilter ? `Reading list: ${this.currentTopicFilter().label}` : 'Reading list';
  }
  private articleLabel(): string {
    return this.snapshot
      ? (articleInfo(this.snapshot.path, this.snapshot.properties)?.title ??
          this.snapshot.file.basename)
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
    if (typeof state.file === 'string')
      await this.openArticle(
        state.file,
        false,
        undefined,
        typeof state.subpath === 'string' ? state.subpath : undefined,
      );
    else await this.readingList();
    await super.setState(state, result);
  }
  async onOpen(): Promise<void> {
    const options = { signal: this.lifetime.signal };
    this.selectionState.install(
      this.contentEl,
      this.lifetime.signal,
      this.host.signal,
      () => !this.stopping && !this.host.signal.aborted,
      () => this.selectionChanged(),
    );
    this.contentEl.addEventListener('focusin', () => this.refreshArticleTopics(), options);
    this.contentEl.ownerDocument.defaultView?.addEventListener(
      'focus',
      () => this.refreshArticleTopics(),
      options,
    );
    this.contentEl.addEventListener(
      'click',
      (event) => {
        if (this.topicClicked(event)) return;
        // Tap mode suppresses modified clicks on its body. Preserve explicit
        // reference navigation before that handler, without also filing a copy.
        if ((event.ctrlKey || event.metaKey) && this.targetClicked(event)) event.stopPropagation();
      },
      { ...options, capture: true },
    );
    this.contentEl.addEventListener('click', (event) => this.clicked(event), options);
    this.contentEl.addEventListener(
      'auxclick',
      (event) => {
        if (event.button === 1 && !this.topicClicked(event)) this.targetClicked(event);
      },
      options,
    );
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
    this.selectionState.cancel();
    this.closing = (async () => {
      try {
        await this.operations.catch((error) => this.error(error));
        // Normal tab/source transitions can await this. Host plugin unload cannot.
        if (!this.host.signal.aborted) {
          this.selectionState.selecting = false;
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
    this.selectionState.cancel();
    this.disposeReading();
  }
  private disposeReading(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.generation++;
    this.clearSend();
    this.passageActions = undefined;
    this.tapHighlighter?.dispose();
    this.tapHighlighter = undefined;
    this.tapMode = false;
    this.clearTapUndo();
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
    if (this.snapshot) this.readingQueue.rename(this.snapshot.path, snapshot.path);
    if (this.snapshot?.body !== snapshot.body) {
      this.automatic = undefined;
      this.lastSelection = '';
      this.tapHighlighter?.reset();
      this.clearTapUndo();
    }
    if (this.ownDeferred?.saved !== snapshot.body) this.ownDeferred = undefined;
    this.snapshot = snapshot;
    this.refreshArticleTopics();
  }
  private syncPresentation(): void {
    const title = this.articleLabel();
    if (this.surface) {
      this.surface.setTitle(title);
      this.refreshArticleTopics();
    } else if (this.articleTitle) this.articleTitle.textContent = title;
    const key = JSON.stringify([this.file?.path, this.queue, this.getDisplayText()]);
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
    shortcut?: string,
  ): HTMLButtonElement {
    const button = parent.createEl(
      'button',
      icon ? { cls: 'reader-icon-button' } : { text: label },
    );
    if (icon) {
      setIcon(button, icon);
      const tooltip = shortcut ? `${label} (${shortcut.toUpperCase()})` : label;
      setTooltip(button, tooltip);
      button.setAttribute('aria-label', label);
      button.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    }
    if (shortcut) {
      button.dataset.readerKey = shortcut;
      button.setAttribute('aria-keyshortcuts', shortcut.toUpperCase());
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
    this.rowIndicators?.dispose();
    this.rowIndicators = undefined;
    this.mountedListRows = undefined;
    this.refreshList = undefined;
    this.topicScan?.abort();
    this.topicScan = undefined;
    this.selectionState.cancel();
    this.articleLifetime.abort();
    this.articleLifetime = new AbortController();
    this.clearSend();
    this.passageActions = undefined;
    this.tapHighlighter?.dispose();
    this.tapHighlighter = undefined;
    this.tapMode = false;
    this.clearTapUndo();
    this.surface?.dispose();
    this.surface = undefined;
    this.shortcutHelp = undefined;
    this.shortcutHelpReturn = undefined;
    this.pendingG = 0;
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
    this.button(
      this.contentEl,
      'Open Markdown',
      () => this.openMarkdown(file),
      'file-pen-line',
      'o',
    );
    this.button(
      this.contentEl,
      'Retry Reader',
      () => this.openArticle(file.path),
      'refresh-cw',
      'r',
    );
    this.button(this.contentEl, 'Back to list', () => this.readingList(), 'list', 'b');
  }
  showList(queue = this.queue): void {
    const focusedRow =
      this.contentEl.contains(this.contentEl.ownerDocument.activeElement) &&
      this.contentEl.ownerDocument.activeElement?.classList.contains('reader-list-item');
    if (queue !== this.queue) {
      this.listSelectedPath = undefined;
      this.focusSelectedListRow = false;
    }
    this.clear();
    this.filteredOrigin = false;
    this.snapshot = undefined;
    this.queue = queue;
    this.syncPresentation();
    const list = this.contentEl.createDiv({ cls: 'reader-list' });
    if (this.topicFilter) {
      const heading = list.createEl('h2', { cls: 'reader-list-heading' });
      heading.textContent = this.listLabel();
    }
    const tabs = this.contentEl.createEl('nav', {
      cls: 'reader-toolbar reader-bottom-controls',
      attr: { 'aria-label': 'Reading list actions' },
    });
    for (const name of queues.filter((name) => name !== 'Archive')) {
      const button = this.button(
        tabs,
        name === 'Feed' ? 'Feed articles' : name,
        () => {
          this.search = '';
          this.listLimit = 50;
          this.showList(name);
        },
        { Inbox: 'inbox', Feed: 'rss', Later: 'clock' }[name],
        { Inbox: 'i', Feed: 'f', Later: 'l' }[name],
      );
      button.classList.toggle('mod-cta', name === queue);
    }
    this.button(tabs, 'Add URL', () => this.host.capture(), 'plus', 'u');
    const filterButton = this.button(
      tabs,
      'Filter by topic',
      () => {
        if (!this.topicFilter) return this.selectTopicFilter();
        this.topicPicker?.abort();
        this.topicFilter = undefined;
        this.filteredPaths = [];
        this.listLimit = 50;
        this.showList();
      },
      'list-filter',
      't',
    );
    filterButton.classList.toggle('reader-filter-active', !!this.topicFilter);
    filterButton.setAttribute('aria-pressed', String(!!this.topicFilter));
    let restoreListFocus = !!focusedRow;
    const wiredRows = new WeakSet<HTMLElement>();
    const mountedRows = new ListRows(list, {
      button: (label, action, icon, shortcut) => this.button(list, label, action, icon, shortcut),
      open: (path) => {
        this.listSelectedPath = path;
        return this.openArticle(path, true);
      },
      more: () => {
        this.listLimit += 50;
        render();
      },
    });
    this.mountedListRows = mountedRows;
    this.observeRowIndicators(list, new Map());
    let scanMessage: HTMLElement | undefined;
    const render = () => {
      scanMessage?.remove();
      scanMessage = undefined;
      const rows = this.topicFilter
        ? this.filteredPaths
            .flatMap((path) => {
              const article = this.host.store.catalog.article(path);
              return article?.queue === queue ? [article] : [];
            })
            .slice(0, this.listLimit + 1)
        : this.host.store.catalog.list(queue, this.search, 0, this.listLimit + 1);
      mountedRows.update(
        rows.slice(0, this.listLimit),
        rows.length > this.listLimit,
        this.topicFilter ? 'No matching articles in this queue.' : 'No articles in this queue.',
      );
      const visibleRows = mountedRows.rows;
      for (const [row, path] of visibleRows) {
        const button = row as HTMLButtonElement;
        button.dataset.readerPath = path;
        if (!wiredRows.has(button)) {
          wiredRows.add(button);
          button.addEventListener('focus', () => this.selectListRow(button, false));
        }
      }
      const buttons = [...visibleRows.keys()] as HTMLButtonElement[];
      const selected =
        buttons.find((button) => button.dataset.readerPath === this.listSelectedPath) ??
        buttons.find((button) => button === list.ownerDocument.activeElement) ??
        buttons[0];
      if (selected) this.selectListRow(selected, false);
      if (selected && (restoreListFocus || this.focusSelectedListRow)) {
        selected.focus({ preventScroll: true });
        restoreListFocus = false;
        this.focusSelectedListRow = false;
      }
      this.rowIndicators?.update(visibleRows);
    };
    this.filteredPaths = [];
    const refresh = () => {
      if (!this.topicFilter) {
        render();
        return;
      }
      const heading = list.querySelector('.reader-list-heading');
      if (heading) heading.textContent = this.listLabel();
      this.syncPresentation();
      this.topicScan?.abort();
      scanMessage?.remove();
      scanMessage = list.createEl('p', { text: 'Filtering articles…', attr: { role: 'status' } });
      const controller = new AbortController();
      this.topicScan = controller;
      const lifetime = this.articleLifetime.signal;
      const abort = () => controller.abort();
      lifetime.addEventListener('abort', abort, { once: true });
      this.host.signal.addEventListener('abort', abort, { once: true });
      const filter = this.currentTopicFilter();
      const generation = this.generation;
      const candidates = this.host.store.catalog.list(queue, '', 0, this.host.store.catalog.size);
      const resolve = (link: string, source: string) =>
        this.app.metadataCache.getFirstLinkpathDest(link, source)?.path;
      void this.topicScanner
        .scan(candidates, {
          signal: controller.signal,
          file: (path) => this.host.store.vault.file(path),
          read: (file) => this.host.store.vault.read(file),
          metadataMatch: (article) => matchesTopicArticle(article, '', filter, resolve),
          bodyMatch: (raw, article) => {
            const document = readDocument(raw);
            // Body matching is intentionally read-only and never triggers acquisition.
            return (
              document.properties.type === 'article' &&
              matchesTopicArticle(article, document.body, filter, resolve)
            );
          },
        })
        .then(({ paths, uncertain }) => {
          if (
            controller.signal.aborted ||
            this.stopping ||
            this.generation !== generation ||
            this.topicScan !== controller
          )
            return;
          this.filteredPaths = paths;
          render();
          if (uncertain)
            scanMessage = list.createEl('p', {
              text: `${uncertain} article(s) could not be checked. Reopen the list to retry.`,
              attr: { role: 'status' },
            });
        })
        .catch((error) => {
          if (!controller.signal.aborted && this.generation === generation) {
            scanMessage?.remove();
            scanMessage = list.createEl('p', {
              text: 'Could not filter articles. Reopen the list to retry.',
              attr: { role: 'alert' },
            });
            this.error(error);
          }
        })
        .finally(() => {
          lifetime.removeEventListener('abort', abort);
          this.host.signal.removeEventListener('abort', abort);
        });
    };
    this.refreshList = refresh;
    refresh();
  }
  private selectListRow(button: HTMLButtonElement, focus: boolean): void {
    this.listSelectedPath = button.dataset.readerPath;
    for (const row of this.contentEl.querySelectorAll<HTMLButtonElement>('.reader-list-item')) {
      const selected = row === button;
      row.classList.toggle('reader-list-selected', selected);
      if (selected) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    if (focus) button.focus();
  }
  private listRows(): HTMLButtonElement[] {
    return Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>('.reader-list-item'));
  }
  private moveListCursor(key: 'j' | 'k' | 'first' | 'last'): void {
    const rows = this.listRows();
    if (!rows.length) return;
    const index = rows.findIndex((row) => row.dataset.readerPath === this.listSelectedPath);
    const next =
      key === 'first'
        ? 0
        : key === 'last'
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, index + (key === 'j' ? 1 : -1)));
    this.selectListRow(rows[next], true);
  }
  private toggleShortcutHelp(): void {
    if (this.shortcutHelp) {
      this.shortcutHelp.remove();
      this.shortcutHelp = undefined;
      if (this.shortcutHelpReturn?.isConnected) this.shortcutHelpReturn.focus();
      this.shortcutHelpReturn = undefined;
      return;
    }
    const active = this.contentEl.ownerDocument.activeElement;
    this.shortcutHelpReturn =
      active instanceof HTMLElement && this.contentEl.contains(active) ? active : undefined;
    const help = this.contentEl.createDiv({
      cls: 'reader-shortcut-help',
      attr: { role: 'dialog', 'aria-label': 'Reader keyboard shortcuts' },
    });
    this.shortcutHelp = help;
    help.createEl('h2', { text: 'Keyboard shortcuts' });
    const list = help.createEl('dl');
    for (const [keys, label] of this.snapshot
      ? [
          ['j / k', 'Next / previous article'],
          ['gg / G', 'Top / bottom'],
          ['d / u', 'Half page down / up'],
          ['Space', 'Full page down'],
          ['q', 'Back to list'],
          ['?', 'Close shortcuts'],
        ]
      : [
          ['j / k', 'Next / previous row'],
          ['Enter', 'Open selected article'],
          ['gg / G', 'First / last visible row'],
          ['?', 'Close shortcuts'],
        ]) {
      list.createEl('dt', { text: keys });
      list.createEl('dd', { text: label });
    }
    const close = help.createEl('button', { text: 'Close shortcuts', attr: { type: 'button' } });
    close.addEventListener('click', () => this.toggleShortcutHelp());
    close.focus();
  }
  /** Resolve aliases afresh so metadata edits do not leave a stale filter vocabulary. */
  private currentTopicFilter(): TopicFilter {
    const filter = this.topicFilter!;
    if (!filter.path) return filter;
    return (
      this.availableTopics().find((topic) => topic.path === filter.path) ?? {
        label: `${filter.label} (unavailable)`,
        terms: [],
      }
    );
  }
  private availableTopics(): TopicFilter[] {
    return this.app.vault
      .getMarkdownFiles()
      .flatMap((file) => {
        const properties = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (properties?.type !== 'topic') return [];
        const aliases = Array.isArray(properties.aliases)
          ? properties.aliases
          : typeof properties.aliases === 'string'
            ? [properties.aliases]
            : [];
        return [
          {
            label: file.basename,
            path: file.path,
            terms: [
              file.basename,
              ...aliases.filter(
                (value): value is string => typeof value === 'string' && !!value.trim(),
              ),
            ],
          },
        ];
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  private async selectTopicFilter(): Promise<void> {
    this.topicPicker?.abort();
    const controller = new AbortController();
    this.topicPicker = controller;
    const abort = () => controller.abort();
    // List data refreshes must not close the picker or discard an invalidation.
    this.lifetime.signal.addEventListener('abort', abort, { once: true });
    this.host.signal.addEventListener('abort', abort, { once: true });
    try {
      if (this.lifetime.signal.aborted || this.host.signal.aborted) return;
      const selected = await chooseTopicFilter(
        this.app,
        this.availableTopics(),
        this.topicFilter,
        controller.signal,
      );
      if (!selected || controller.signal.aborted || this.stopping || this.snapshot) return;
      this.topicFilter = selected;
      this.listLimit = 50;
      this.showList();
    } finally {
      this.lifetime.signal.removeEventListener('abort', abort);
      this.host.signal.removeEventListener('abort', abort);
      if (this.topicPicker === controller) this.topicPicker = undefined;
    }
  }
  /** Positive-only, visible-row decoration. No catalog scan, promotion or persisted state. */
  private observeRowIndicators(list: HTMLElement, rows: Map<HTMLElement, string>): () => void {
    const generation = this.generation;
    const indicators = new RowIndicators(
      list,
      {
        file: (path) => this.host.store.vault.file(path),
        read: (file) => this.host.store.vault.read(file),
        signal: this.articleLifetime.signal,
        hostSignal: this.host.signal,
        active: () => !this.stopping && this.generation === generation,
      },
      this.indicatorSlots,
    );
    this.rowIndicators = indicators;
    indicators.update(rows);
    return () => {
      indicators.dispose();
      if (this.rowIndicators === indicators) this.rowIndicators = undefined;
    };
  }
  openArticle(
    path: string,
    fromList = false,
    signal?: AbortSignal,
    subpath?: string,
  ): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    this.topicPicker?.abort();
    this.cancelNodeCreation();
    // Snapshot every matching result at the click, not just the rendered first 50.
    const browsing = fromList
      ? {
          queue: this.queue,
          filtered: !!this.topicFilter,
          paths: this.topicFilter
            ? [...this.filteredPaths]
            : this.host.store.catalog
                .list(this.queue, this.search, 0, this.host.store.catalog.size)
                .map((article) => article.path),
        }
      : undefined;
    return this.operation(
      () => this.openArticleNow(path, browsing, signal, !fromList, subpath),
      false,
    );
  }
  private async openArticleNow(
    path: string,
    browsing?: BrowsingContext,
    signal?: AbortSignal,
    direct = false,
    subpath?: string,
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
      const snapshot = await this.host.store.read(path);
      if (
        this.stopping ||
        this.lifetime.signal.aborted ||
        this.host.signal.aborted ||
        signal?.aborted ||
        token !== this.generation
      )
        return;
      targetFile = snapshot.file;
      const article = articleInfo(path, snapshot.properties)!;
      // Commit direct entry only after leaving and destination reads succeed. A failed
      // save/cancel must leave the current article and its filtered List route intact.
      if (direct) {
        this.filteredOrigin = false;
        this.topicFilter = undefined;
        this.filteredPaths = [];
        this.readingQueue = new ReadingQueue();
      }
      const origin =
        browsing ??
        (!this.readingQueue.current
          ? {
              queue: article.queue ?? this.queue,
              paths: article.queue ? this.host.store.catalog.paths(article.queue) : [path],
            }
          : undefined);
      // Keep the old article and browsing context until all awaited work and modal
      // cancellation checks finish. A cancelled capture cannot steal the current view.
      this.clear();
      token = this.generation;
      this.snapshot = snapshot;
      if (browsing) this.filteredOrigin = browsing.filtered === true;
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
      const column = this.contentEl.createDiv({
        cls: this.host.paged ? 'reader-article reader-has-page-actions' : 'reader-article',
      });
      const surface = new ReadingSurface(
        column,
        this.host.paged,
        (marker) => this.persistPosition(marker),
        (error) => {
          if (this.current(snapshot, token!) && !this.stopping)
            this.showFailure(snapshot.file, error);
        },
        (target, element) => this.paintReferenceIcon(target, element, snapshot.file),
      );
      this.surface = surface;
      this.articleTitle = surface.title;
      setTooltip(
        surface.title,
        'J/K: next/previous article · Space: page · D/U: half-page · gg/G: top/bottom · Q: list · ?: shortcuts',
      );
      if (this.filteredOrigin && this.topicFilter) {
        const context = surface.title.ownerDocument.createElement('div');
        context.className = 'reader-article-context';
        context.textContent = this.listLabel();
        surface.title.before(context);
      }
      this.syncPresentation();
      surface.setBody(snapshot.body, article.url);
      if (this.surface !== surface) return; // The synchronous error callback installed the escape hatch.
      surface.restore(readingMarker(snapshot.properties.bookmark) ?? '');
      if (this.surface !== surface) return;
      if (subpath) this.revealSubpath(surface, subpath);
      this.status = column.createDiv({ cls: 'reader-status', attr: { role: 'status' } });
      column.prepend(this.status); // Feedback stays clear of the floating controls.
      this.actions = column.createEl('nav', {
        cls: this.host.paged
          ? 'reader-actions reader-paged-actions reader-bottom-controls'
          : 'reader-actions reader-bottom-controls',
        attr: { 'aria-label': 'Article actions' },
      });
      this.controls();
      try {
        const marked = await this.host.store.dogEar(snapshot.path, () => {
          if (!this.current(snapshot, token!) || signal?.aborted || request !== this.opening)
            throw new Error('Article navigation was cancelled.');
        });
        if (this.current(snapshot, token)) this.adoptSnapshot(marked);
      } catch (error) {
        if (this.current(snapshot, token)) this.error(error);
      }
      if (article.url && this.current(snapshot, token))
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
  refreshArticleControls(): void {
    if (!this.actions || !this.surface) return;
    const expanded = this.surface.paged;
    this.actions.classList.toggle('reader-paged-actions', expanded);
    this.actions.parentElement?.classList.toggle('reader-has-page-actions', expanded);
    this.controls();
  }
  private revealSubpath(surface: ReadingSurface, subpath: string): void {
    let fragment: string;
    try {
      fragment = decodeURIComponent(subpath);
    } catch {
      return;
    }
    const match = /^#\^([a-zA-Z0-9-]+)$/.exec(fragment);
    if (!match || this.surface !== surface) return;
    const targets = [
      ...surface.body.querySelectorAll<HTMLElement>('[data-reader-paragraph]'),
    ].filter((element) => element.dataset.readerParagraph === match[1]);
    // A native block ID names a paragraph, not a highlight. Never silently choose
    // the first of duplicate authored IDs, and never persist this transient intent.
    if (targets.length === 1) surface.reveal(targets[0]);
  }
  private paintReferenceIcon(target: string, element: HTMLElement, source: TFile): void {
    try {
      const api = nodesApi(this.app),
        path = nativeLinkPath(target, false);
      const file = path
        ? this.app.metadataCache.getFirstLinkpathDest(parseLinktext(path).path, source.path)
        : null;
      const node = file && api ? api.getNode(file.path) : null;
      const types = api?.listTypes() ?? [];
      if (!node || node.path !== file?.path || !hasNodeClass(node, types)) return;
      const icon =
        node.icon ?? types.find((type) => type.icon && node.classes.includes(type.type))?.icon;
      if (icon) setIcon(element, icon);
    } catch {
      /* Optional public-provider failures must not hide reference labels. */
    }
  }
  private controls(): void {
    if (!this.snapshot || !this.actions || !this.surface) return;
    this.syncPresentation();
    if (this.tapHighlighter?.active) {
      this.updateStatus();
      return;
    }
    this.tapHighlighter?.dispose();
    this.tapHighlighter = undefined;
    this.actions.empty();
    if (this.surface.paged) {
      for (const [label, direction] of [
        ['Previous page', -1],
        ['Next page', 1],
      ] as const) {
        const button = this.button(
          this.actions,
          label,
          () => {
            this.surface?.page(direction);
            this.controls();
          },
          direction === -1 ? 'chevron-up' : 'chevron-down',
          direction === -1 ? 'z' : 'x',
        );
        button.disabled = this.surface.atBoundary(direction);
      }
    }
    this.button(this.actions, 'Related notes', () => this.topics(), 'tags', 't');
    const statusButton = this.button(
      this.actions,
      'Change status and advance',
      () => this.changeStatus(),
      'list-filter',
      's',
    );
    statusButton.setAttribute('aria-label', 'Change article status and advance');
    const statusTooltip = 'Change status and advance · S: choose · L: Later · A: Archive';
    setTooltip(statusButton, statusTooltip);
    this.button(this.actions, 'Delete', () => this.finish('delete'), 'trash-2').setAttribute(
      'aria-label',
      'Trash article and advance',
    );
    this.button(this.actions, 'List', () => this.readingList(), 'list', 'b');
    this.setupTapHighlighter();
    this.updateStatus();
  }
  private updatePagingControls(): void {
    if (!this.surface?.paged) return;
    for (const [key, direction] of [
      ['z', -1],
      ['x', 1],
    ] as const) {
      const button = this.actions?.querySelector<HTMLButtonElement>(
        `button[data-reader-key="${key}"]`,
      );
      if (button) button.disabled = this.surface.atBoundary(direction);
    }
  }
  private setupTapHighlighter(): void {
    if (!this.surface || !this.actions) return;
    const surface = this.surface;
    this.tapHighlighter = new TapHighlighter(surface.viewport, surface.body, this.actions, {
      active: this.tapMode,
      mode: this.tapKind,
      canUndo: !!this.tapUndo && Date.now() <= this.tapUndoUntil,
      modeChanged: (active, mode) => {
        this.tapMode = active;
        if (active) this.tapKind = mode === 'node' ? 'node' : 'highlight';
        this.invalidateSelection();
        this.automatic = undefined;
        this.lastSelection = '';
        surface.body.ownerDocument.getSelection()?.removeAllRanges();
        surface.refresh();
        if (!active) this.controls();
      },
      passageActions: () => this.passageActions,
      onTarget: (event) => this.targetClicked(event),
      onPassage: (word, event) => {
        const origin =
          word.startContainer.nodeType === 1
            ? (word.startContainer as Element)
            : word.startContainer.parentElement;
        const mark = origin?.closest('mark');
        if (!mark || !surface.body.contains(mark)) return false;
        this.selectPassageMark(mark, event);
        return true;
      },
      clearPassage: (intent) => {
        this.passageActions = undefined;
        if (intent) {
          this.passageIntent++;
          this.cancelNodeCreation();
        }
      },
      save: (range, mode) =>
        mode === 'node'
          ? this.saveTapNode(surface.body, range)
          : this.saveTapSelection(surface.body, range),
      undo: () => this.undoTapHighlight(),
      notify: (error) => this.error(error),
    });
  }
  private updateStatus(): void {
    if (!this.snapshot || !this.status) return;
    const article = articleInfo(this.snapshot.path, this.snapshot.properties)!;
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
        'r',
      );
  }
  private invalidateSelection(): number {
    return this.selectionState.invalidate();
  }
  private selectionChanged(): void {
    if (this.stopping || this.host.signal.aborted || this.dialog) return;
    const revision = this.invalidateSelection();
    if (this.tapMode) return;
    const range = this.surface && selectionRange(this.surface.body);
    if (!range) {
      this.automatic = undefined;
      this.lastSelection = '';
      this.surface?.refresh();
      return;
    }
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
      // Keep live events cheap: materialize quote/context only after the quiet period.
      // Copy endpoints, not a live Range (whose boundaries can follow DOM mutations).
      const start = range.startContainer,
        startOffset = range.startOffset,
        end = range.endContainer,
        endOffset = range.endOffset,
        body = surface.displayedBody;
      const currentRange = () => {
        const live = selectionRange(surface.body);
        return (
          live?.startContainer === start &&
          live.startOffset === startOffset &&
          live.endContainer === end &&
          live.endOffset === endOffset
        );
      };
      const active = (hosted = false) => {
        return !(
          this.stopping ||
          this.selecting ||
          surface.pointerActive ||
          (this.dialog && !hosted) ||
          this.selectionState.revision !== revision ||
          this.surface !== surface ||
          !this.current(source, generation) ||
          surface.displayedBody !== body ||
          !this.acceptsSource(this.snapshot!, body, true)
        );
      };
      let pending: PendingSelection;
      const valid = (hosted = false) => {
        if (!active(hosted)) return false;
        // A destination modal owns focus/Selection. Its captured source words stay
        // immutable; modal text selection must not invalidate that source intent.
        if (hosted && this.dialog) return true;
        if (!currentRange()) return false;
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
      this.selectionState.schedule(() => {
        if (!active() || !currentRange()) return;
        const selection = surface.selection();
        if (!selection) return;
        // Immutable text/source snapshot is captured before entering any async queue.
        pending = {
          selection: { quote: selection.quote, before: selection.before, after: selection.after },
          body,
        };
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
    valid: (hosted?: boolean) => boolean = () => true,
    leaving = false,
  ): Promise<void> {
    await this.positionWrite;
    const closing = leaving && this.stopping && !!pending && !this.host.signal.aborted;
    if (
      this.tapMode ||
      ((this.stopping || this.articleLifetime.signal.aborted) && !closing) ||
      !valid()
    )
      return;
    const selection = pending?.selection ?? this.surface?.selection(),
      snapshot = this.snapshot;
    if (
      !selection ||
      !snapshot ||
      this.selectionState.selecting ||
      this.surface?.pointerActive ||
      this.dialog
    )
      return;
    const key = JSON.stringify([selection.quote, selection.before, selection.after]);
    if (key === this.lastSelection) return;
    if (this.writing) {
      await this.writing;
      return this.saveSelection(pending, valid, leaving);
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
    // No source mark is dispatched until a typed destination has been chosen.
    locateSelection(body, selection.quote, selection.before, selection.after);
    // Transient paint only: PendingSelection remains immutable text/source authority.
    // Capture after timer/position waits so the selectionchange event has finished.
    const feedbackSurface = this.surface,
      nativeRange = feedbackSurface?.selection()?.range,
      acknowledge =
        !this.stopping && nativeRange ? feedbackSurface?.highlightFeedback(nativeRange) : undefined;
    const superseded = new Error('The selection changed before the highlight was saved.');
    let edit: HostedHighlight | undefined;
    const promise = this.withHighlightHost(
      snapshot,
      '',
      { inherit: true, allowDeferred: true, noPicker: leaving, closing },
      async (base, nodes, createdPaths, validate, authorize) => {
        const guard = (phase: HighlightCollectionPhase = 'source') => {
          // Once A's source annotation is saved, a new native selection B must not
          // abandon A's quote. Provider/lifetime/source/target guards still apply;
          // B retains its own settled-selection timer and immutable captured text.
          if (phase === 'source' && !valid(true)) throw superseded;
          if (!this.current(snapshot, generation))
            throw new Error('The article changed before the highlight was saved.');
          this.assertDisplayed(base, true);
          if (!this.acceptsSource(base, displayed, true))
            throw new Error('The selected source is no longer current.');
          validate();
        };
        guard();
        edit = hostSelection(
          body,
          selection,
          nodes.map((node) => node.path),
        );
        try {
          return await this.collectHosted(
            base,
            edit,
            nodes,
            createdPaths,
            guard,
            'quote',
            displayed,
          );
        } catch (cause) {
          this.offerCollectionRetry(base, edit, nodes, createdPaths, undefined, cause, authorize);
          throw cause;
        }
      },
    ).catch((error) => {
      // Expected supersession is a cancelled automatic action, not a failed disk write.
      if (error !== superseded) throw error;
    });
    this.writing = promise;
    try {
      const saved = await promise;
      if (!saved || !this.current(snapshot, generation)) {
        this.lastSelection = key;
        return;
      }
      this.clearTapUndo();
      this.automatic = edit
        ? this.passageAfterWrite(edit.body, edit.passage, saved.body)
        : undefined;
      this.lastSelection = key;
      if (this.surface?.displayedBody === saved.body) this.ownDeferred = undefined;
      this.controls();
      if (
        !this.stopping &&
        this.surface === feedbackSurface &&
        saved.body === edit?.body &&
        saved.body !== snapshot.body
      )
        acknowledge?.();
    } finally {
      if (this.writing === promise) this.writing = undefined;
    }
  }
  private saveTapNode(root: HTMLElement, range: Range): Promise<void> {
    // Capture exactly the same rendered, block-scoped tap range as Highlight mode.
    const selection = selectedPassage(root, range),
      snapshot = this.snapshot,
      displayed = this.surface?.displayedBody,
      generation = this.generation,
      signal = this.articleLifetime.signal;
    if (!selection || !snapshot)
      return Promise.reject(new Error('Tap a word in the current article first.'));
    return this.operation(async () => {
      await this.positionWrite;
      const base = this.snapshot;
      if (
        signal.aborted ||
        this.stopping ||
        !this.current(snapshot, generation) ||
        !base ||
        base.body !== snapshot.body ||
        displayed !== base.body
      )
        throw new Error('The article changed. Tap the first word again.');
      this.assertDisplayed(base);
      locateSelection(base.body, selection.quote, selection.before, selection.after);
      const promise = this.withHighlightHost(
        base,
        selection.quote,
        {
          title: 'Create node from passage',
          actionLabel: 'Link passage',
          tone: 'node',
          multiple: false,
          // No inherited highlight host: choosing an existing typed note is explicit.
        },
        async (source, nodes, createdPaths, validate) => {
          const guard = () => {
            if (signal.aborted || this.stopping || !this.current(base, generation))
              throw new Error('The article changed before the note link could be saved.');
            this.assertDisplayed(source);
            validate();
          };
          guard();
          const edit = {
            ...mentionSelection(source.body, selection, nodes[0].path),
            quoteMarkdown: '',
          };
          return this.collectHosted(source, edit, nodes, createdPaths, guard, 'mention');
        },
      );
      this.writing = promise;
      try {
        const saved = await promise;
        if (!saved || signal.aborted || !this.current(base, generation) || this.stopping) return;
        this.automatic = undefined;
        this.lastSelection = '';
        this.ownDeferred = undefined;
        this.clearTapUndo();
        this.surface?.setBody(saved.body, text(saved.properties.url));
        this.tapHighlighter?.reset();
        this.controls();
      } finally {
        if (this.writing === promise) this.writing = undefined;
      }
    });
  }
  private saveTapSelection(root: HTMLElement, range: Range): Promise<void> {
    // Capture text and source synchronously, before another operation or repaint can run.
    const selection = selectedPassage(root, range),
      snapshot = this.snapshot;
    const generation = this.generation,
      signal = this.articleLifetime.signal;
    const displayed = this.surface?.displayedBody;
    if (!selection || !snapshot)
      return Promise.reject(new Error('Tap a word in the current article first.'));
    return this.operation(async () => {
      await this.positionWrite;
      const base = this.snapshot;
      if (
        signal.aborted ||
        this.stopping ||
        !this.current(snapshot, generation) ||
        !base ||
        base.body !== snapshot.body ||
        displayed !== base.body
      )
        throw new Error('The article changed. Tap the first word again.');
      this.assertDisplayed(base);
      locateSelection(base.body, selection.quote, selection.before, selection.after);
      let edit: HostedHighlight | undefined;
      const promise = this.withHighlightHost(
        base,
        '',
        { inherit: true },
        async (source, nodes, createdPaths, validate, authorize) => {
          const guard = () => {
            if (signal.aborted || this.stopping || !this.current(base, generation))
              throw new Error('The article changed before the highlight could be saved.');
            this.assertDisplayed(source);
            validate();
          };
          guard();
          edit = hostSelection(
            source.body,
            selection,
            nodes.map((node) => node.path),
          );
          try {
            return await this.collectHosted(source, edit, nodes, createdPaths, guard);
          } catch (cause) {
            this.offerCollectionRetry(
              source,
              edit,
              nodes,
              createdPaths,
              undefined,
              cause,
              authorize,
            );
            throw cause;
          }
        },
      );
      this.writing = promise;
      try {
        const saved = await promise;
        if (!saved || signal.aborted || !this.current(base, generation) || this.stopping) return;
        this.automatic = undefined;
        this.lastSelection = '';
        this.ownDeferred = undefined;
        this.clearTapUndo();
        const passage = edit
          ? this.passageAfterWrite(edit.body, edit.passage, saved.body)
          : undefined;
        if (passage) {
          // Source-local Undo retains the paragraph anchor and remembered hosts.
          // Destination quotations are user-owned snapshots and are never reversed.
          const receipt = {
            snapshot: saved,
            before: changePassage(saved.body, passage, 'remove'),
            passage,
          };
          this.tapUndo = receipt;
          this.tapUndoUntil = Date.now() + 6000;
          this.tapUndoTimer = setTimeout(() => {
            if (this.tapUndo === receipt) this.clearTapUndo();
          }, 6000);
        }
        this.surface?.setBody(saved.body, text(saved.properties.url));
        this.tapHighlighter?.setUndoAvailable(!!this.tapUndo);
        if (passage && this.surface?.displayedBody === saved.body) this.passageMenu(passage);
        this.controls();
      } finally {
        if (this.writing === promise) this.writing = undefined;
      }
    });
  }
  private undoTapHighlight(): Promise<void> {
    // Undo is a new explicit intent: release an uncooperative picker before queuing.
    this.cancelNodeCreation();
    const receipt = this.tapUndo,
      generation = this.generation;
    const signal = this.articleLifetime.signal;
    return this.operation(async () => {
      await this.positionWrite;
      const base = this.snapshot;
      if (
        !receipt ||
        receipt !== this.tapUndo ||
        Date.now() > this.tapUndoUntil ||
        !base ||
        base.file !== receipt.snapshot.file ||
        base.body !== receipt.snapshot.body ||
        signal.aborted ||
        this.stopping ||
        !this.current(base, generation)
      ) {
        this.clearTapUndo();
        throw new Error(
          'This highlight can no longer be undone safely. Tap it for highlight actions.',
        );
      }
      this.assertDisplayed(base);
      const next = changePassage(base.body, receipt.passage, 'remove');
      if (next !== receipt.before)
        throw new Error('The highlighted passage changed. Nothing was removed.');
      clearTimeout(this.tapUndoTimer);
      this.tapUndoTimer = undefined;
      const promise = this.host.store.annotate(base, (raw) => {
        if (
          receipt !== this.tapUndo ||
          signal.aborted ||
          this.stopping ||
          !this.current(base, generation)
        )
          throw new Error('The article changed before Undo could be saved.');
        this.assertDisplayed(base);
        return replaceBody(raw, base.body, next);
      });
      this.writing = promise;
      try {
        const saved = await promise;
        if (signal.aborted || !this.current(base, generation) || this.stopping) return;
        this.snapshot = saved;
        this.clearTapUndo();
        this.tapHighlighter?.reset();
        this.surface?.setBody(saved.body, text(saved.properties.url));
        this.controls();
      } finally {
        if (this.writing === promise) this.writing = undefined;
        if (this.tapUndo === receipt) this.clearTapUndo();
      }
    });
  }
  private clearTapUndo(): void {
    clearTimeout(this.tapUndoTimer);
    this.tapUndoTimer = undefined;
    this.tapUndo = undefined;
    this.tapUndoUntil = 0;
    this.tapHighlighter?.setUndoAvailable(false);
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
            const request = this.nodeCreation;
            if (before && request?.source.file === before.file && request.source.raw === before.raw)
              request.source = saved;
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
    this.selectionState.cancel();
    await this.positionWrite;
    // Leaving can finish a known sole typed default, but must never start a new
    // picker after the navigation/close intent has already cancelled modal work.
    await this.saveSelection(pending, () => true, true);
    await this.writing;
    this.surface?.flush();
    await this.positionWrite;
  }
  flush(): Promise<void> {
    return this.operation(() => this.prepareToLeave(), false);
  }
  /** Public palette route. Checking availability must never cancel a live Nodes request. */
  articleCommand(
    command: 'move' | 'topics' | 'open-markdown' | 'open-url',
    checking: boolean,
  ): boolean {
    if (
      this.stopping ||
      this.host.signal.aborted ||
      !this.file ||
      (command !== 'open-markdown' && !this.snapshot)
    )
      return false;
    if (command === 'open-url') {
      const snapshot = this.snapshot!;
      if (!articleInfo(snapshot.path, snapshot.properties)?.url) return false;
      if (!checking)
        window.open(text(snapshot.properties.url).trim(), '_blank', 'noopener,noreferrer');
      return true;
    }
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
  private async changeStatus(destination?: Queue): Promise<void> {
    this.cancelNodeCreation();
    const snapshot = this.snapshot,
      generation = this.generation,
      signal = this.articleLifetime.signal;
    if (!snapshot) return;
    const target =
      destination ??
      (await choose(this.app, 'Change article status…', [...queues], (queue) => queue, signal));
    if (target && !signal.aborted && this.current(snapshot, generation))
      await this.finish('next', target);
  }
  private finish(action: 'next' | 'delete', destination?: Queue): Promise<void> {
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
      const moved = destination ? await this.host.store.move(snapshot, destination) : undefined;
      if (action === 'delete') await this.host.store.trash(snapshot);
      if (!this.current(snapshot, generation) || this.stopping) return;
      if (destination === 'Later') new Notice('Saved to Later');
      if (moved && (destination === 'Inbox' || destination === 'Later'))
        void this.host.ingestion.acquire(moved.path).catch((error) => this.error(error));
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
        (await choose(this.app, 'Change article status…', [...queues], (queue) => queue, signal));
      if (!target || signal.aborted || !this.current(snapshot, generation)) return;
      this.assertDisplayed(snapshot, true);
      const moved = await this.host.store.move(snapshot, target);
      if (!this.current(snapshot, generation) || this.stopping) return;
      this.adoptSnapshot(moved);
      if (moved.body !== snapshot.body)
        this.surface?.setBody(moved.body, text(moved.properties.url));
      this.controls();
      if (target === 'Later') new Notice('Saved to Later');
      if (target === 'Inbox' || target === 'Later')
        void this.host.ingestion.acquire(moved.path).catch((error) => this.error(error));
    });
  }
  private refreshArticleTopics(): void {
    const snapshot = this.snapshot,
      surface = this.surface;
    if (!snapshot || !surface || this.stopping || this.lifetime.signal.aborted) return;
    const stored = snapshot.properties.topics,
      values = Array.isArray(stored) ? stored : stored === undefined ? [] : [stored],
      topics: { target?: string; label: string }[] = [],
      seen = new Set<string>();
    for (const value of values) {
      const raw = text(value),
        path = linkPath(raw);
      if (!path) continue;
      let file: TFile | null = null;
      try {
        file = this.app.metadataCache.getFirstLinkpathDest(path, snapshot.path);
      } catch {
        // Preserve valid authored topic labels even if native resolution is unavailable.
      }
      if (file === snapshot.file) continue;
      const key = file?.path ?? path;
      if (seen.has(key)) continue;
      seen.add(key);
      const alias = /\|([^\]]*)\]\]$/.exec(raw)?.[1];
      topics.push({
        target: file?.path,
        label: alias || file?.basename || path.replace(/\.md$/, '').split('/').pop() || path,
      });
    }
    surface.setTopics(topics);
  }
  private relatedNodes(snapshot: Snapshot<TFile>, api: NodesApi): NodeResult[] {
    const stored = snapshot.properties.topics;
    const values = Array.isArray(stored) ? stored : stored === undefined ? [] : [stored];
    const types = api.listTypes(),
      nodes = new Map<string, NodeResult>();
    for (const value of values) {
      const link = linkPath(text(value));
      const file = link ? this.app.metadataCache.getFirstLinkpathDest(link, snapshot.path) : null;
      const node = file && file !== snapshot.file ? api.getNode(file.path) : null;
      if (node && node.path === file!.path && hasNodeClass(node, types)) nodes.set(node.path, node);
    }
    return [...nodes.values()];
  }
  /** Snapshot public membership and file identity, including unchecked originals. */
  private nodeAuthority(
    api: NodesApi | undefined,
    nodes: readonly NodeResult[],
  ): (paths?: readonly string[]) => void {
    if (!api) throw new Error('Fileclass Inline changed. Reopen the note picker.');
    const types = new Set(api.listTypes().map((type) => type.type));
    const originals = nodes.map((node) => ({
      path: node.path,
      file: this.app.vault.getAbstractFileByPath(node.path),
      classes: node.classes.filter((type) => types.has(type)),
    }));
    return (paths) => {
      if (nodesApi(this.app) !== api)
        throw new Error('Fileclass Inline changed. Reopen the note picker.');
      const registered = new Set(api.listTypes().map((type) => type.type));
      if (paths?.some((path) => !originals.some((node) => node.path === path)))
        throw new Error('The original destination is no longer known. Reopen the note picker.');
      for (const original of originals) {
        if (paths && !paths.includes(original.path)) continue;
        const current = api.getNode(original.path);
        if (
          !(original.file instanceof TFile) ||
          original.file.path !== original.path ||
          this.app.vault.getAbstractFileByPath(original.path) !== original.file ||
          !current ||
          current.path !== original.path ||
          !Array.isArray(current.classes) ||
          !original.classes.some((type) => registered.has(type) && current.classes.includes(type))
        )
          throw new Error(
            'The typed destination changed or lost its Fileclass membership. Reopen its picker.',
          );
      }
    };
  }
  private topics(): Promise<void> {
    this.cancelNodeCreation();
    const epoch = this.nodeCreationEpoch;
    return this.operation(async () => {
      await this.prepareToLeave();
      const initial = this.snapshot,
        generation = this.generation;
      if (!initial || this.stopping || epoch !== this.nodeCreationEpoch) return;
      let snapshot = initial;
      this.assertDisplayed(snapshot, true);
      const signal = this.articleLifetime.signal,
        api = nodesApi(this.app);
      if (!api)
        throw new Error(
          'Editing related notes requires Fileclass Inline public Nodes API v2. Existing topic filters remain available.',
        );
      let selectedPaths = this.relatedNodes(snapshot, api).map((node) => node.path);
      let createdOnce = false;
      const alive = () =>
        !signal.aborted &&
        !this.lifetime.signal.aborted &&
        !this.host.signal.aborted &&
        !this.stopping &&
        epoch === this.nodeCreationEpoch &&
        this.current(snapshot, generation) &&
        this.snapshot?.body === snapshot.body;
      const active = () => alive() && nodesApi(this.app) === api;
      while (active()) {
        const base = this.snapshot!,
          originals = this.relatedNodes(base, api),
          baseline = originals.map((node) => node.path),
          validateOriginals = this.nodeAuthority(api, originals);
        let created = false,
          attempted = false;
        try {
          await this.withHighlightHost(
            base,
            '',
            {
              title: 'Related notes',
              tone: 'neutral',
              multiple: true,
              selectedPaths,
              minSelection: 0,
              actionLabel: 'Apply',
              allowCreate: !createdOnce,
              allowDeferred: true,
              epoch,
              onSelected: (nodes) => {
                selectedPaths = nodes.map((node) => node.path);
              },
              onCreateAttempt: (nodes) => {
                createdOnce = true;
                attempted = true;
                selectedPaths = nodes.map((node) => node.path);
              },
            },
            async (source, nodes, createdPaths, validate) => {
              const guard = () => {
                if (!active()) throw new Error('The article changed. Reopen Related notes.');
                this.assertDisplayed(source, true);
                validate();
                validateOriginals();
              };
              guard();
              // Only the created note's link is durable before completion. Other
              // checked/unchecked choices remain a draft until an explicit Apply.
              const paths = createdPaths.length
                ? [...new Set([...baseline, ...createdPaths])]
                : nodes.map((node) => node.path);
              const saved = await this.host.store.setRelatedNodes(source, paths, baseline, guard);
              if (this.current(snapshot, generation) && !this.stopping) {
                this.adoptSnapshot(saved);
                // Advance only from this guarded write's receipt, never arbitrary
                // reread bytes. A native retention move may legitimately rewrite links.
                snapshot = saved;
                if (saved.body !== source.body)
                  this.surface?.setBody(saved.body, text(saved.properties.url));
                this.controls();
              }
              created = createdPaths.length > 0;
              return saved;
            },
          );
          if (!created && !attempted) return;
        } catch (cause) {
          if (!alive()) return;
          this.error(cause);
          if (!active()) return;
        }
        await this.positionWrite;
        if (!active()) return;
        // Reopen after any settled creation attempt, including provider Cancel,
        // null-without-callback, or failure. Keep the draft, never auto-retry a
        // write, adopt arbitrary bytes, or allow a second creation attempt.
        const known = this.snapshot;
        if (!known || !this.acceptsSource(known, this.surface?.displayedBody, true)) return;
        try {
          const current = await this.host.store.read(known.path);
          if (
            !active() ||
            this.snapshot !== known ||
            current.file !== known.file ||
            current.raw !== known.raw
          )
            return;
        } catch {
          return;
        }
      }
    });
  }
  private topicClicked(event: MouseEvent): boolean {
    const link =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>('a[data-reader-topic]')
        : null;
    if (
      !link ||
      !this.surface?.topics.contains(link) ||
      !link.dataset.readerTopic ||
      (event.button !== 0 && event.button !== 1)
    )
      return false;
    event.preventDefault();
    event.stopPropagation();
    void this.openLinked(
      link.dataset.readerTopic,
      event.button === 1 || event.ctrlKey || event.metaKey,
    ).catch((error) => this.error(error));
    return true;
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
  private async collectHosted(
    source: Snapshot<TFile>,
    edit: Pick<HostedHighlight, 'body' | 'quoteMarkdown' | 'blockId'>,
    nodes: readonly NodeResult[],
    createdPaths: readonly string[],
    validate: (phase: HighlightCollectionPhase) => void,
    mode: 'quote' | 'mention' = 'quote',
    displayed?: string,
    removal?: HighlightRemoval,
  ): Promise<Snapshot<TFile>> {
    const generation = this.generation;
    const guard = (phase: HighlightCollectionPhase) => {
      validate(phase);
      removal?.validate(removal.paths);
    };
    const adopt = (saved: Snapshot<TFile>) => {
      if (!this.current(source, generation) || this.stopping) return;
      this.adoptSnapshot(saved);
      if (displayed !== undefined) this.ownDeferred = { displayed, saved: saved.body };
      this.surface?.setBody(saved.body, text(saved.properties.url));
      if (this.surface?.displayedBody === saved.body) this.ownDeferred = undefined;
      this.controls();
    };
    try {
      const saved =
        nodes.length === 1 && !removal?.paths.length
          ? await this.host.store.collectHighlight(source, edit, nodes[0].path, {
              guard,
              created: createdPaths.includes(nodes[0].path),
              ...(mode === 'mention' ? { mode: 'mention' as const } : {}),
            })
          : nodes.length || removal?.paths.length
            ? await this.host.store.collectHighlightMany(
                source,
                edit,
                nodes.map((node) => node.path),
                {
                  guard,
                  createdPaths,
                  ...(removal
                    ? {
                        removedDestinationPaths: removal.paths,
                        previousQuote: removal.previousQuote,
                      }
                    : {}),
                },
              )
            : await this.host.store.annotate(source, (raw) => {
                guard('source');
                return replaceBody(raw, source.body, edit.body);
              });
      adopt(saved);
      return saved;
    } catch (error) {
      // A source-first multi-file write can retain/save the article before a target
      // fails. Show that actual saved state and report the partial failure explicitly.
      if (error instanceof PartialCollectionError && error.snapshot?.file === source.file)
        adopt(error.snapshot as Snapshot<TFile>);
      throw error;
    }
  }
  /** Reader owns destination choice; Fileclass owns typed creation and required completion. */
  private async withHighlightHost(
    source: Snapshot<TFile>,
    title: string,
    options: {
      inherit?: boolean;
      node?: NodeResult;
      nodes?: NodeResult[];
      directNodes?: NodeResult[];
      includeNodes?: NodeResult[];
      title?: string;
      multiple?: boolean;
      selectedPaths?: string[];
      minSelection?: number;
      actionLabel?: string;
      tone?: 'highlight' | 'node' | 'neutral';
      allowCreate?: boolean;
      onCreateAttempt?: (existing: NodeResult[]) => void;
      onSelected?: (nodes: NodeResult[]) => void;
      onPickFromArticle?: (nodes: NodeResult[]) => void;
      allowDeferred?: boolean;
      noPicker?: boolean;
      closing?: boolean;
      epoch?: number;
    },
    commit: (
      source: Snapshot<TFile>,
      nodes: NodeResult[],
      createdPaths: string[],
      validate: () => void,
      authorize: (paths?: readonly string[]) => void,
    ) => Promise<Snapshot<TFile>>,
  ): Promise<Snapshot<TFile> | undefined> {
    const epoch = options.epoch ?? this.nodeCreationEpoch;
    await this.positionWrite;
    if (epoch !== this.nodeCreationEpoch) return;
    const snapshot = this.snapshot,
      generation = this.generation,
      signal = options.closing ? this.lifetime.signal : this.articleLifetime.signal;
    if (
      signal.aborted ||
      (this.stopping && !options.closing) ||
      !snapshot ||
      snapshot.file !== source.file ||
      snapshot.body !== source.body
    )
      return;
    this.assertDisplayed(snapshot, options.allowDeferred);
    const api = nodesApi(this.app);
    if (!api) {
      if (options.noPicker) return;
      throw new Error(
        'Hosted highlights and related notes require Fileclass Inline public Nodes API v2. Existing highlights remain readable and editable.',
      );
    }
    const types = api.listTypes(),
      minimum = options.minSelection ?? 1;
    if (!types.length && minimum > 0)
      throw new Error(
        'No Fileclass destinations are available. Configure a typed note before highlighting.',
      );
    const request = { controller: new AbortController(), source: snapshot, writing: false };
    this.nodeCreation = request;
    const abort = () => request.controller.abort();
    for (const lifetime of [signal, this.host.signal]) {
      if (lifetime.aborted) abort();
      else lifetime.addEventListener('abort', abort, { once: true });
    }
    let settleCancellation!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      settleCancellation = () => resolve(null);
      if (request.controller.signal.aborted) settleCancellation();
      else request.controller.signal.addEventListener('abort', settleCancellation, { once: true });
    });
    let accepting = true,
      attempted = false;
    let saved: Snapshot<TFile> | undefined, pendingLink: Promise<void> | undefined;
    const check = () => {
      if (!accepting)
        throw new Error(
          'The highlight destination request has finished; its callback was cancelled.',
        );
      if (request.controller.signal.aborted)
        throw new Error('The highlight destination request was cancelled.');
      if (epoch !== this.nodeCreationEpoch)
        throw new Error('A newer Reader action cancelled the highlight destination request.');
      if (!this.current(snapshot, generation) || (this.stopping && !options.closing))
        throw new Error('The article changed or the highlight destination request was cancelled.');
      if (nodesApi(this.app) !== api)
        throw new Error('Fileclass Inline changed. Choose the highlight destination again.');
    };
    const selection = (nodes: NodeResult[], required?: { path: string; type: string }) => {
      const selected = [...new Map(nodes.map((node) => [node?.path, node])).values()].map(
        (node) => {
          if (
            !node ||
            !hasNodeClass(node, types) ||
            (required?.path === node.path && !node.classes.includes(required.type))
          )
            throw new Error(
              'The selected note must belong to the chosen Fileclass. Reader has not reclassified it.',
            );
          return { ...node, classes: [...node.classes], aliases: [...node.aliases] };
        },
      );
      const targets = selected.map((node) => ({
        path: node.path,
        file: this.host.store.vault.file(node.path),
        classes:
          required?.path === node.path
            ? [required.type]
            : node.classes.filter((type) => types.some((choice) => choice.type === type)),
      }));
      // Retain only public provider/file/class authority for an explicit retry.
      // The original request's check() must expire, but its target identities and
      // a newly created note's requested Fileclass must never be reacquired.
      const authorize = (paths?: readonly string[]) => {
        if (nodesApi(this.app) !== api)
          throw new Error('Fileclass Inline changed. Choose the highlight destination again.');
        if (paths?.some((path) => !targets.some((target) => target.path === path)))
          throw new Error('The original destination is no longer known. Reopen the note picker.');
        const currentTypes = api.listTypes();
        for (const { path, file, classes } of targets) {
          if (paths && !paths.includes(path)) continue;
          const current = api.getNode(path);
          if (
            !file ||
            file === source.file ||
            file.path !== path ||
            this.host.store.vault.file(path) !== file ||
            !current ||
            current.path !== path ||
            !hasNodeClass(current, currentTypes) ||
            !classes.some(
              (type) =>
                current.classes.includes(type) &&
                currentTypes.some((choice) => choice.type === type),
            )
          )
            throw new Error('The typed destination changed or was deleted. Choose it again.');
        }
      };
      const validate = () => {
        check();
        authorize();
      };
      validate();
      return { selected, validate, authorize };
    };
    const link = (
      nodes: NodeResult[],
      createdPaths: string[] = [],
      required?: { path: string; type: string },
    ): Promise<void> => {
      const result = (async () => {
        check();
        if (attempted) throw new Error('The highlight creation callback already ran.');
        attempted = true;
        options.onSelected?.(nodes);
        const { selected, validate, authorize } = selection(
          [...(options.includeNodes ?? []), ...nodes],
          required,
        );
        if (selected.length < minimum || (options.multiple === false && selected.length !== 1))
          throw new Error('Choose at least one typed destination for a new highlight.');
        request.writing = true;
        try {
          saved = await commit(request.source, selected, createdPaths, validate, authorize);
          request.source = saved;
        } finally {
          request.writing = false;
        }
        await this.checkNodeCreation();
        check();
      })();
      if (!pendingLink) pendingLink = result;
      void result.catch(() => {});
      return result;
    };
    try {
      check();
      let direct = options.directNodes ?? (options.node ? [options.node] : undefined);
      const preferred = options.inherit ? this.relatedNodes(snapshot, api) : [];
      if (preferred.length === 1 && !direct) direct = preferred;
      if (!direct && options.noPicker) return;
      // Only an actual modal owns focus/Selection. Inherited sole defaults retain
      // the live native range check through the final source annotation boundary.
      if (!direct) this.dialog = true;
      const fixedChoice =
        !direct && options.nodes
          ? choose(
              this.app,
              options.title ?? 'Choose highlighted destination',
              options.nodes,
              (node) => node.title,
              request.controller.signal,
            ).then((node) => (node ? { kind: 'existing' as const, node } : null))
          : undefined;
      const choice = direct
        ? { kind: 'existing-many' as const, nodes: direct }
        : await Promise.race([
            fixedChoice ??
              chooseHighlightHost(this.app, api, {
                title: options.title ?? 'Add highlight to notes',
                query: title,
                preferredPaths: preferred.map((node) => node.path),
                multiple: options.multiple !== false,
                selectedPaths: [...(options.selectedPaths ?? [])],
                minSelection: minimum,
                actionLabel: options.actionLabel ?? 'Add highlight',
                tone: options.tone ?? 'highlight',
                allowCreate: options.allowCreate,
                allowPickFromArticle: !!options.onPickFromArticle,
                signal: request.controller.signal,
              }),
            cancelled,
          ]);
      if (!choice || request.controller.signal.aborted) return;
      check();
      if (choice.kind === 'existing') await link([choice.node]);
      else if (choice.kind === 'existing-many') await link(choice.nodes);
      else if (choice.kind === 'pick-in-article') {
        if (!options.onPickFromArticle)
          throw new Error('Choose from article is unavailable for this action.');
        options.onPickFromArticle(selection(choice.nodes).selected);
      } else {
        if (options.allowCreate === false)
          throw new Error('Only one new note may be created in this selection flow.');
        if (!api.createNodeForLink)
          throw new Error(
            'Creating a typed destination requires Fileclass Inline createNodeForLink support. Choose an existing typed note instead.',
          );
        if (!types.some(({ type }) => type === choice.type))
          throw new Error('The chosen Fileclass is no longer available.');
        const existing = selection(choice.existingNodes ?? []).selected;
        options.onCreateAttempt?.(existing);
        // The single-use durable callback precedes required completion. Never
        // commit from the provider return value or remove a created note.
        await Promise.race([
          api.createNodeForLink(
            {
              type: choice.type,
              suggestedTitle: choice.title,
              sourcePath: request.source.path,
              signal: request.controller.signal,
            },
            (created) =>
              link([...existing, created], [created.path], {
                path: created.path,
                type: choice.type,
              }),
          ),
          cancelled,
        ]);
      }
      return saved;
    } finally {
      accepting = false;
      signal.removeEventListener('abort', abort);
      this.host.signal.removeEventListener('abort', abort);
      request.controller.signal.removeEventListener('abort', settleCancellation);
      if (this.nodeCreation === request) {
        this.nodeCreation = undefined;
        this.dialog = false;
      }
      await pendingLink; // Drain dispatched writes, never an uncooperative provider.
    }
  }
  private clearSend(): void {
    this.sendSource = undefined;
    this.surface?.body.classList.remove('reader-send-active');
    for (const mark of this.surface?.body.querySelectorAll('.reader-send-source') ?? [])
      mark.classList.remove('reader-send-source');
  }
  private armSend(
    passage: Passage,
    draft: NodeResult[] = [],
    mode: 'selected' | 'explicit' = 'explicit',
  ): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.assertDisplayed(snapshot);
    this.clearSend();
    const generation = this.generation;
    if (!this.tapHighlighter?.active) this.tapHighlighter?.setActive(true);
    this.sendSource = { snapshot, passage, generation, draft, mode };
    this.surface?.body.classList.add('reader-send-active');
    const index = this.passages(snapshot.body).findIndex(
      (item) => item.from === passage.from && item.to === passage.to,
    );
    const marks = this.surface?.body.querySelectorAll<HTMLElement>('mark') ?? [];
    for (const [ordinal, mark] of [...marks].entries())
      if (
        mark.dataset.readerPassage === String(index) ||
        (!mark.hasAttribute('data-reader-passage') && ordinal === index)
      )
        mark.classList.add('reader-send-source');
    if (mode === 'selected') return;
    this.passageActions = [
      {
        id: 'cancel-send',
        label: 'Cancel choosing from article',
        icon: 'x',
        run: () => {
          this.cancelNodeCreation();
          if (this.current(snapshot, generation) && this.snapshot?.body === snapshot.body)
            this.passageMenu(passage);
        },
      },
    ];
    this.tapHighlighter?.refreshActions();
  }
  private typedDestinations(paths: readonly string[]): NodeResult[] {
    const source = this.snapshot,
      api = nodesApi(this.app);
    if (!source || !api)
      throw new Error('Sending highlights requires Fileclass Inline public Nodes API v2.');
    const types = api.listTypes(),
      nodes: NodeResult[] = [];
    for (const target of paths) {
      const safe = nativeLinkPath(target, false);
      const file = safe
        ? this.app.metadataCache.getFirstLinkpathDest(parseLinktext(safe).path, source.path)
        : undefined;
      const node = file ? api.getNode(file.path) : null;
      if (node && hasNodeClass(node, types) && !nodes.some((item) => item.path === node.path))
        nodes.push(node);
    }
    return nodes;
  }
  private targetClicked(event: MouseEvent): boolean {
    const element = event.target instanceof Element ? event.target : undefined;
    const link = element?.closest<HTMLAnchorElement>('a.internal-link[href]');
    if (!link || !this.surface?.body.contains(link) || this.surface.selection()) return false;
    const reference = link.closest('.reader-reference-group');
    if (!reference && this.sendSource?.mode !== 'explicit') return false;
    // A highlighted link chooses that highlight's hosts; a pill chooses its exact node.
    if (this.sendSource && !reference && element?.closest('mark')) return false;
    event.preventDefault();
    try {
      const target = nativeLinkPath(link.getAttribute('href')!);
      if (!target) throw new Error('This is not a safe vault-note destination.');
      if (event.ctrlKey || event.metaKey || event.button === 1) {
        void this.openLinked(target, true).catch((error) => this.error(error));
      } else if (this.sendSource) {
        const nodes = this.typedDestinations([target]);
        if (nodes.length !== 1)
          throw new Error(
            'Choose a typed Fileclass note. This link is not an eligible destination.',
          );
        this.sendToNodes(nodes);
      } else {
        const source = this.snapshot;
        if (!source) throw new Error('The article is no longer open.');
        this.assertDisplayed(source);
        const index = reference?.getAttribute('data-reader-passage');
        const passage =
          index && /^\d+$/.test(index) ? this.passages(source.body)[Number(index)] : undefined;
        if (!passage)
          throw new Error(
            'This reference cannot be matched safely to a highlight. Open Markdown to edit it.',
          );
        this.passageMenu(passage, event);
        const edit = this.passageActions?.find((action) => action.id === 'link-note');
        if (!edit || edit.disabled)
          throw new Error(
            'Editing highlight destinations requires Fileclass Inline public Nodes API v2.',
          );
        void Promise.resolve(edit.run()).catch((error) => this.error(error));
      }
    } catch (error) {
      this.error(error);
    }
    return true;
  }
  private passages(body: string): Passage[] {
    return this.surface?.analysis.passages(body) ?? passages(body);
  }
  private sendToPassage(passage: Passage): void {
    try {
      const hosts = this.snapshot ? passageHosts(this.snapshot.body, passage) : [];
      // An original inline note link is not another host when an explicit source
      // citation records this excerpt's actual destinations. Preserve that link;
      // use the legacy wrapped target only when no hosted association exists.
      const nodes = this.typedDestinations(
        hosts.length ? hosts : passage.target ? [passage.target] : [],
      );
      if (!nodes.length)
        throw new Error(
          'This highlight has no typed destination. Click a linked highlight or a typed node instead.',
        );
      this.sendToNodes(nodes);
    } catch (error) {
      this.error(error);
    }
  }
  private sendToNodes(nodes: NodeResult[]): void {
    const send = this.sendSource;
    if (!send) return;
    this.cancelNodeCreation();
    const epoch = this.nodeCreationEpoch,
      intent = this.passageIntent;
    void this.operation(async () => {
      if (epoch !== this.nodeCreationEpoch) return;
      if (
        !this.current(send.snapshot, send.generation) ||
        this.snapshot?.body !== send.snapshot.body
      )
        throw new Error('The source highlight changed. Choose its destinations again.');
      await this.editPassage(send.snapshot, send.passage, 'highlight', epoch, intent, {
        ...(nodes.length === 1 ? { direct: nodes } : { limited: nodes }),
        include: send.mode === 'explicit' ? send.draft : [],
        addOnly: send.mode === 'selected',
      });
    }).catch((error) => this.error(error));
  }
  private clicked(event: MouseEvent): void {
    const element = event.target instanceof Element ? event.target : undefined;
    if (this.surface?.body.contains(element ?? null) && this.surface.selection()) {
      // Releasing a native selection over a URL must not also open/capture that URL.
      if (element?.closest('a[href]')) event.preventDefault();
      return;
    }
    if (this.targetClicked(event)) return;
    const mark = element?.closest('mark');
    if (mark && this.surface?.body.contains(mark) && this.snapshot && !this.surface.selection()) {
      event.preventDefault();
      this.selectPassageMark(mark, event);
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
      if (target)
        this.surface.reveal(
          target.hidden && target.parentElement?.hasAttribute('data-reader-paragraph')
            ? target.parentElement
            : target,
        );
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
          // Capture owns new-note status; duplicates retain their status and placement.
          // Save/capture stays in the current article and its original browsing context.
          void this.host.ingestion.acquire(file.path, true).catch((error) => {
            if (!signal.aborted) this.error(error);
          });
          new Notice('Article saved.');
        },
        [signal, this.host.signal],
      );
    }
  }
  private selectPassageMark(mark: Element, event: MouseEvent): void {
    if (!this.snapshot || !this.surface?.body.contains(mark) || this.surface.selection()) return;
    try {
      this.assertDisplayed(this.snapshot);
      const marks = [...this.surface.body.querySelectorAll('mark')],
        source = this.passages(this.snapshot.body),
        mapped = mark.getAttribute('data-reader-passage');
      const index =
        mapped !== null && /^\d+$/.test(mapped)
          ? Number(mapped)
          : marks.length === source.length
            ? marks.indexOf(mark as HTMLElement)
            : -1;
      if (index < 0 || !source[index])
        throw new Error(
          'This highlight contains unsupported formatting. Use Open Markdown to edit it safely.',
        );
      const passage = source[index];
      if (passage) {
        if (this.sendSource?.mode === 'explicit') this.sendToPassage(passage);
        else this.passageMenu(passage, event);
      }
    } catch (error) {
      this.error(error);
    }
  }
  private passageAfterWrite(
    expectedBody: string,
    expected: Passage | undefined,
    body: string,
  ): Passage | undefined {
    if (!expected) return;
    const matches = this.passages(body).filter(
      (item) =>
        item.text === expected.text &&
        item.target === expected.target &&
        (body !== expectedBody || item.from === expected.from),
    );
    // Relocation may rewrite links. Bind only to the actual saved body and decline
    // ambiguous matches rather than carrying pre-move offsets into a new source.
    return matches.length === 1 ? matches[0] : undefined;
  }
  private nativeHostPaths(snapshot: Snapshot<TFile>, passage: Passage): string[] {
    return [
      ...new Set(
        passageHosts(snapshot.body, passage).map((target) => {
          const safe = nativeLinkPath(target, false);
          const file = safe
            ? this.app.metadataCache.getFirstLinkpathDest(parseLinktext(safe).path, snapshot.path)
            : null;
          if (!file || file === snapshot.file)
            throw new Error(
              'An existing highlight destination no longer resolves safely. Fix its link in Markdown before editing destinations.',
            );
          return file.path;
        }),
      ),
    ];
  }
  private offerCollectionRetry(
    original: Snapshot<TFile>,
    edit: Pick<HostedHighlight, 'body' | 'quoteMarkdown' | 'blockId'>,
    nodes: readonly NodeResult[],
    createdPaths: readonly string[],
    removal: HighlightRemoval | undefined,
    error: unknown,
    authorize: (paths?: readonly string[]) => void,
  ): void {
    if (
      !(error instanceof PartialCollectionError) ||
      !error.annotationSaved ||
      error.snapshot.file !== original.file ||
      !edit.quoteMarkdown.trim()
    )
      return;
    const remainingNodes = nodes.filter(
      (node) => !error.completedDestinationPaths.includes(node.path),
    );
    const remainingCreated = createdPaths.filter((path) =>
      remainingNodes.some((node) => node.path === path),
    );
    const remainingPaths = (removal?.paths ?? []).filter(
      (path) => !error.completedRemovalPaths.includes(path),
    );
    if (!remainingNodes.length && !remainingPaths.length) return;
    const saved = error.snapshot as Snapshot<TFile>,
      generation = this.generation;
    if (!this.current(original, generation) || this.stopping || this.snapshot?.body !== saved.body)
      return;
    const remainingRemoval =
      remainingPaths.length && removal ? { ...removal, paths: remainingPaths } : undefined;
    this.tapHighlighter?.setActive(true);
    this.passageActions = [
      {
        id: 'retry-note-updates',
        label: 'Retry note updates',
        icon: 'rotate-ccw',
        run: () => {
          this.cancelNodeCreation();
          const epoch = this.nodeCreationEpoch;
          void this.operation(async () => {
            await this.positionWrite;
            const base = this.snapshot;
            if (
              !base ||
              epoch !== this.nodeCreationEpoch ||
              !this.current(saved, generation) ||
              base.body !== saved.body
            )
              throw new Error('The source changed. Reopen it before retrying note updates.');
            await this.withHighlightHost(
              base,
              '',
              { directNodes: remainingNodes, minSelection: 0, epoch },
              async (source, selected, _created, validate) => {
                const guard = () => {
                  if (
                    !this.current(saved, generation) ||
                    this.stopping ||
                    this.snapshot?.body !== saved.body
                  )
                    throw new Error('The source changed before note updates could be retried.');
                  this.assertDisplayed(source);
                  validate();
                  authorize(selected.map((node) => node.path));
                };
                const currentEdit = { ...edit, body: source.body };
                try {
                  const result = await this.collectHosted(
                    source,
                    currentEdit,
                    selected,
                    remainingCreated,
                    guard,
                    'quote',
                    undefined,
                    remainingRemoval,
                  );
                  this.tapHighlighter?.reset();
                  this.controls();
                  return result;
                } catch (cause) {
                  this.offerCollectionRetry(
                    source,
                    currentEdit,
                    selected,
                    remainingCreated,
                    remainingRemoval,
                    cause,
                    authorize,
                  );
                  throw cause;
                }
              },
            );
          }).catch((cause) => this.error(cause));
        },
      },
    ];
    this.tapHighlighter?.refreshActions();
  }
  private async editPassage(
    snapshot: Snapshot<TFile>,
    passage: Passage,
    mode: 'highlight' | 'mention',
    epoch: number,
    intent: number,
    choice?: {
      direct?: NodeResult[];
      limited?: NodeResult[];
      include?: NodeResult[];
      addOnly?: boolean;
    },
  ): Promise<void> {
    const generation = this.generation,
      signal = this.articleLifetime.signal;
    const previousPaths = mode === 'highlight' ? this.nativeHostPaths(snapshot, passage) : [];
    const previousNodes = this.typedDestinations(previousPaths);
    if (previousNodes.length !== previousPaths.length)
      throw new Error('The typed destination changed. Tap the highlight again.');
    const removalAuthority = this.nodeAuthority(nodesApi(this.app), previousNodes);
    let edit:
      | (Pick<HostedHighlight, 'body' | 'blockId' | 'quoteMarkdown'> & { removed?: boolean })
      | undefined;
    const showSaved = (saved: Snapshot<TFile> | undefined) => {
      if (
        !saved ||
        mode === 'mention' ||
        edit?.removed ||
        signal.aborted ||
        this.stopping ||
        epoch !== this.nodeCreationEpoch ||
        this.passageIntent !== intent ||
        !this.current(snapshot, generation) ||
        this.snapshot?.body !== saved.body ||
        this.surface?.displayedBody !== saved.body
      )
        return;
      const expected = edit
        ? this.passages(edit.body).find((item) => item.from === passage.from)
        : undefined;
      const selected = edit ? this.passageAfterWrite(edit.body, expected, saved.body) : undefined;
      if (selected) {
        this.passageMenu(selected);
        if (choice?.addOnly) this.armSend(selected, [], 'selected');
      }
    };
    const saved = await this.withHighlightHost(
      snapshot,
      mode === 'mention' ? passage.text : '',
      {
        title: mode === 'mention' ? 'Convert passage to note link' : 'Add highlight to notes',
        multiple: mode !== 'mention',
        minSelection: mode === 'mention' ? 1 : 0,
        selectedPaths: previousPaths,
        actionLabel: mode === 'mention' ? 'Convert to note link' : 'Apply',
        tone: mode === 'mention' ? 'node' : 'highlight',
        epoch,
        ...(choice?.direct ? { directNodes: choice.direct } : {}),
        ...(choice?.limited ? { nodes: choice.limited } : {}),
        ...(choice?.include ? { includeNodes: choice.include } : {}),
        ...(mode === 'highlight'
          ? {
              onPickFromArticle: (nodes: NodeResult[]) => {
                if (
                  epoch !== this.nodeCreationEpoch ||
                  !this.current(snapshot, generation) ||
                  this.snapshot?.body !== snapshot.body
                )
                  throw new Error('The source highlight changed. Choose its destinations again.');
                this.armSend(passage, nodes);
              },
            }
          : {}),
      },
      async (base, nodes, createdPaths, validate, authorize) => {
        const guard = () => {
          if (signal.aborted || this.stopping || !this.current(snapshot, generation))
            throw new Error('The article changed. Tap the highlight again.');
          this.assertDisplayed(base);
          validate();
        };
        guard();
        edit =
          mode === 'mention'
            ? { ...convertPassage(base.body, passage, nodes[0].path), quoteMarkdown: '' }
            : choice?.addOnly
              ? hostPassage(
                  base.body,
                  passage,
                  nodes.map((node) => node.path),
                )
              : replacePassageHosts(
                  base.body,
                  passage,
                  nodes.map((node) => node.path),
                );
        const removed = choice?.addOnly
          ? []
          : previousPaths.filter((path) => !nodes.some((node) => node.path === path));
        const removal = removed.length
          ? {
              paths: removed,
              previousQuote: { quoteMarkdown: edit.quoteMarkdown, blockId: edit.blockId },
              validate: removalAuthority,
            }
          : undefined;
        let saved: Snapshot<TFile>;
        try {
          saved = await this.collectHosted(
            base,
            edit,
            nodes,
            createdPaths,
            guard,
            mode === 'mention' ? 'mention' : 'quote',
            undefined,
            removal,
          );
        } catch (cause) {
          if (mode === 'highlight')
            this.offerCollectionRetry(base, edit, nodes, createdPaths, removal, cause, authorize);
          throw cause;
        }
        // Fresh actions must be usable before a provider's required completion,
        // even if it never settles. Old snapshots/buttons cannot dispatch edits.
        showSaved(saved);
        return saved;
      },
    );
    showSaved(saved);
  }
  private passageMenu(passage: Passage, event?: MouseEvent): void {
    if (!this.snapshot) return;
    this.assertDisplayed(this.snapshot);
    if (event) {
      this.passageIntent++;
      this.cancelNodeCreation();
    }
    const intent = this.passageIntent;
    const actions: TapToolbarAction[] = [];
    const snapshot = this.snapshot!,
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
        throw new Error('The article text changed. Tap the highlight again.');
      const saved = await this.host.store.annotate(base, (raw) => {
        if (signal.aborted || !this.current(snapshot, generation) || this.stopping)
          throw new Error('The article changed. Tap the highlight again.');
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
      this.clearTapUndo();
      this.tapHighlighter?.reset();
      this.surface?.setBody(saved.body, text(saved.properties.url));
      if (action !== 'remove' && this.tapMode && this.passageIntent === intent) {
        const expected = changePassage(snapshot.body, passage, action, target);
        const changed = this.passages(expected).find((item) => item.from === passage.from);
        const selected = this.passageAfterWrite(expected, changed, saved.body);
        if (selected && this.surface?.displayedBody === saved.body) this.passageMenu(selected);
      }
      this.controls();
      return saved;
    };
    const action = (
      id: string,
      label: string,
      icon: string,
      run: (epoch: number) => void | Promise<unknown>,
      serialize = true,
    ) =>
      actions.push({
        id,
        label,
        icon,
        run: () => {
          // A new passage action supersedes the pending Nodes dialog before queuing.
          // Capture creation's epoch at the click, after cancelling any older request.
          this.cancelNodeCreation();
          const epoch = this.nodeCreationEpoch;
          const invoke = async () => {
            if (
              !signal.aborted &&
              epoch === this.nodeCreationEpoch &&
              this.current(snapshot, generation)
            )
              await run(epoch);
          };
          void (serialize ? this.operation(invoke) : invoke()).catch((error) => this.error(error));
        },
      });
    const api = nodesApi(this.app);
    const references = passageHosts(snapshot.body, passage);
    const hosts = [
      ...new Set(references.length ? references : passage.target ? [passage.target] : []),
    ];
    for (const [index, host] of hosts.entries())
      action(
        index ? `open-note-${index}` : 'open-note',
        hosts.length === 1 ? 'Open note' : `Open ${host.replace(/\.md$/i, '').split('/').pop()}`,
        'file-symlink',
        () => this.openLinked(host),
        false,
      );
    const pick = (mode: 'highlight' | 'mention', epoch: number) =>
      this.editPassage(snapshot, passage, mode, epoch, intent);
    if (api) {
      action('link-note', 'Add highlight to notes…', 'highlighter', (epoch) =>
        pick('highlight', epoch),
      );
      action('convert-node', 'Convert to note link…', 'file-symlink', (epoch) =>
        pick('mention', epoch),
      );
    } else {
      actions.push({
        id: 'link-note',
        label: 'Add highlight to notes… (requires Fileclass Inline v2)',
        icon: 'link',
        disabled: true,
        run() {},
      });
      actions.push({
        id: 'convert-node',
        label: 'Convert to note link… (requires Fileclass Inline v2)',
        icon: 'file-symlink',
        disabled: true,
        run() {},
      });
    }
    if (hosts.length)
      action('unlink', 'Remove references (article only)', 'unlink', () => apply('unlink'));
    action('remove-highlight', 'Remove highlight (article only)', 'eraser', () => apply('remove'));
    this.tapHighlighter?.setActive(true);
    this.tapHighlighter?.reset();
    this.passageActions = actions;
    this.tapHighlighter?.refreshActions();
    if (event) this.armSend(passage, [], 'selected');
  }
  private cancelNodeCreation(): void {
    // Explicit navigation/action intent only, never save/render/position/background flush.
    // Run before entering the operation queue that Nodes currently occupies.
    this.nodeCreationEpoch++;
    const selection = this.surface?.selection();
    if (selection && this.nodeCreation)
      this.lastSelection = JSON.stringify([selection.quote, selection.before, selection.after]);
    this.clearSend();
    this.topicAssignment?.abort();
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
    this.rowIndicators?.invalidate(change.path);
    if (change.previousPath) this.rowIndicators?.invalidate(change.previousPath);
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
    if (change.previousPath) {
      if (this.listSelectedPath === change.previousPath) this.listSelectedPath = change.path;
      this.mountedListRows?.rename(change.previousPath, change.path);
      if (this.mountedListRows) this.rowIndicators?.update(this.mountedListRows.rows);
      this.readingQueue.rename(change.previousPath, change.path);
      if (this.topicFilter?.path === change.previousPath)
        this.topicFilter = { ...this.topicFilter, path: change.path };
    }
    if (this.topicFilter && this.snapshot && change.path === this.topicFilter.path) this.controls();
    if (this.topicFilter && !this.snapshot) this.topicScan?.abort();
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
      if ((change.metadataChanged || this.topicFilter) && this.listFrame === undefined)
        this.listFrame = requestAnimationFrame(() => {
          this.listFrame = undefined;
          if (
            !this.snapshot &&
            !this.loadingPath &&
            !this.lifetime.signal.aborted &&
            (this.topicFilter || this.contentEl.ownerDocument.activeElement?.tagName !== 'INPUT')
          )
            this.refreshList?.();
        });
      return;
    }
    if (this.snapshot.file.path !== change.path) {
      this.refreshArticleTopics();
      return;
    }
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
      if (
        current.body !== before.body ||
        text(current.properties.url) !== text(before.properties.url)
      )
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
    const doc = this.containerEl.ownerDocument;
    if (
      this.stopping ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (event.shiftKey && !['G', '?'].includes(event.key)) ||
      event.isComposing ||
      this.dialog ||
      doc.getSelection()?.isCollapsed === false
    )
      return;
    const target = event.target as Element | null;
    if (target && target !== doc.body && !this.contentEl.contains(target)) return;
    if (
      target?.closest?.(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),.modal,.menu',
      ) ||
      doc.querySelector('.modal-container,.menu')
    )
      return;
    if (this.shortcutHelp) {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault();
        this.toggleShortcutHelp();
      } else if (event.key !== 'Tab') event.preventDefault();
      return;
    }
    const reading = !!this.snapshot && !!this.surface;
    if (
      !this.tapMode &&
      event.repeat &&
      event.key === ' ' &&
      reading &&
      !target?.closest?.('button,a,[role="button"]') &&
      !doc.activeElement?.closest?.('button,a,[role="button"]')
    ) {
      event.preventDefault();
      return;
    }
    if (
      !this.tapMode &&
      !event.repeat &&
      (event.key === '?' ||
        event.key === 'G' ||
        event.key === 'g' ||
        (!reading && ['j', 'k', 'Enter'].includes(event.key)) ||
        (reading && ['d', 'u', 'q', ' '].includes(event.key)))
    ) {
      if (event.key === '?') {
        event.preventDefault();
        this.pendingG = 0;
        this.toggleShortcutHelp();
        return;
      }
      if (event.key === 'g') {
        event.preventDefault();
        if (this.pendingG > Date.now()) {
          this.pendingG = 0;
          if (reading) {
            this.surface?.jumpTo(-1);
            this.updatePagingControls();
          } else this.moveListCursor('first');
        } else this.pendingG = Date.now() + 900;
        return;
      }
      this.pendingG = 0;
      if (event.key === 'G') {
        event.preventDefault();
        if (reading) {
          this.surface?.jumpTo(1);
          this.updatePagingControls();
        } else this.moveListCursor('last');
        return;
      }
      if (!reading) {
        if (event.key === 'Enter') {
          // Preserve native Enter on toolbar controls; a selected row is still a button.
          if (target?.closest?.('button') && !target.closest('.reader-list-item')) return;
          const row = this.listRows().find(
            (candidate) => candidate.dataset.readerPath === this.listSelectedPath,
          );
          if (row) {
            event.preventDefault();
            row.click();
          }
        } else {
          event.preventDefault();
          this.moveListCursor(event.key as 'j' | 'k');
        }
        return;
      }
      if (
        event.key === ' ' &&
        (target?.closest?.('button,a,[role="button"]') ||
          doc.activeElement?.closest?.('button,a,[role="button"]'))
      )
        return;
      event.preventDefault();
      if (event.key === 'q') {
        void this.readingList()
          .then(() => {
            if (!this.stopping && !this.snapshot) {
              const row = this.listRows().find(
                (candidate) => candidate.dataset.readerPath === this.listSelectedPath,
              );
              if (row) row.focus();
              else this.focusSelectedListRow = true;
            }
          })
          .catch((error) => this.error(error));
      } else {
        this.surface?.moveByPage(event.key === 'u' ? -1 : 1, event.key === ' ' ? 1 : 0.5);
        this.updatePagingControls();
      }
      return;
    }
    if (event.key !== 'g') this.pendingG = 0;
    // Route visible controls through their shortcuts, except status destinations
    // grouped under one button. Tap mode keeps its own contextual keys.
    if (!Platform.isMobile && !event.repeat && !this.tapMode && this.snapshot) {
      if (event.key === 'l' || event.key === 'a') {
        event.preventDefault();
        void this.changeStatus(event.key === 'l' ? 'Later' : 'Archive').catch((error) =>
          this.error(error),
        );
        return;
      }
    }
    if (!Platform.isMobile && !event.repeat && /^[a-z1-9]$/.test(event.key)) {
      const button = Array.from(
        this.contentEl.querySelectorAll<HTMLButtonElement>('button[data-reader-key]'),
      ).find(
        (candidate) =>
          candidate.dataset.readerKey === event.key && !candidate.disabled && !candidate.hidden,
      );
      if (button) {
        event.preventDefault();
        button.click();
        return;
      }
    }
    if (!this.snapshot || !this.surface) return;
    const direction = ['ArrowDown', 'PageDown'].includes(event.key)
      ? 1
      : ['ArrowUp', 'PageUp'].includes(event.key)
        ? -1
        : undefined;
    if (this.tapMode) {
      if (direction && this.host.paged) {
        event.preventDefault();
        this.surface.page(direction);
      } else if (
        ['j', 'k'].includes(event.key) ||
        (direction && this.surface.atBoundary(direction))
      ) {
        event.preventDefault();
      }
      return;
    }
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
      if (event.repeat) return;
      event.preventDefault();
      void (event.key === 'j' ? this.finish('next') : this.navigate(-1)).catch((error) =>
        this.error(error),
      );
    }
  }
  protects(file: TFile): boolean {
    return this.file === file || this.loadingPath === file.path;
  }
  get file(): TFile | undefined {
    return this.snapshot?.file ?? this.fallbackFile;
  }
  get busy(): boolean {
    return (
      this.operating ||
      !!this.writing ||
      this.selectionState.selecting ||
      !!this.surface?.selection()
    );
  }
}
