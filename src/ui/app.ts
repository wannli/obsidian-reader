import type { Article, ArticleStatus } from '../types';
import { queueLabel, statusFromPath } from '../reading-layout';
import type { ReaderController } from '../controller';
import { mountReader, type ReaderHost, type ReaderMount } from './reader';
import type { ReadingPosition } from './eink-types';
import { element, messageOf } from './dom';
import { watchReaderViewport } from './viewport';
import { watchReaderKeys } from './keyboard';
import type { ReaderOpenOptions, ReaderState } from './reader-state';
import { focusReaderTarget } from './reader-focus';
import { createArticleEnd } from './article-end';
// Match the native Switch queue picker's order; stop rather than wrap at either end.
const QUEUES: ArticleStatus[] = ['inbox', 'later', 'feed', 'archive'];
/** One instance and one queue identity per native Obsidian leaf. */
export class ReaderApp {
  private root = element('div', 'r2-app');
  private pane = element('main', 'r2-content');
  private items: Article[] = [];
  private article?: Article;
  private active = '';
  private readingQueue?: ArticleStatus = 'inbox';
  private subpath?: string;
  private snapshot = '';
  private positions = new Map<string, number>();
  private readingPositions = new Map<string, ReadingPosition>();
  private positionGenerations = new Map<string, number>();
  private rememberPosition(path: string, scroll?: HTMLElement, anchor?: ReadingPosition) {
    if (scroll) this.positions.set(path, scroll.scrollTop);
    if (anchor) this.readingPositions.set(path, anchor);
    if (scroll || anchor) this.positionGenerations.set(path, this.controller.repository.articleGeneration(path));
  }
  private rememberedPosition(path: string) {
    return this.positionGenerations.get(path) === this.controller.repository.articleGeneration(path);
  }
  private stopReader: ReaderMount = () => {};
  private positionWrites = new Set<Promise<void>>();
  private disposeMount() {
    const mount = this.stopReader; this.stopReader = () => {};
    // Disposal captures the terminal position before detaching the DOM. Track every
    // retired mount, not only the one still active when close/unload begins.
    const write = mount() ?? mount.flushPosition?.();
    if (write) this.trackPositionWrite(write);
  }
  private trackPositionWrite(write: Promise<void>) {
    this.positionWrites.add(write); void write.finally(() => this.positionWrites.delete(write)).catch(() => {});
  }
  /** Capture the active anchor and drain all current/retired mount writes. Errors
   * remain visible through each mount's persistence reporter; this never disables it. */
  async flushPosition(): Promise<void> {
    const write = this.stopReader.flushPosition?.(); if (write) this.trackPositionWrite(write);
    while (this.positionWrites.size) await Promise.allSettled([...this.positionWrites]);
  }
  private stopEink = () => {};
  private stopActive = () => {};
  private articleEnd?: ReturnType<typeof createArticleEnd>;
  private articleEndError?: string;
  private stopViewport: () => void;
  private stopKeys: () => void;
  private unsubscribe: () => void;
  private disposed = false;
  private initialized = false;
  private revision = 0;
  private openRevision = 0;
  private navigationRevision = 0;
  private moving?: { path: string; navigation: number; finish: boolean; paths: Map<string, string>; generations: Map<string, number> };
  private recordedRenames = new Map<string, string>();
  constructor(target: HTMLElement, private controller: ReaderController, private host: ReaderHost) {
    this.root.dataset.mobile = String(host.isMobile === true);
    this.root.append(this.pane);
    // Completion controls belong to every reading mode, not just mobile.
    // Callbacks read live state, never the article from the first mount.
    this.articleEnd = createArticleEnd({
      archive: () => this.runArticleEnd(() => this.moveArticle('archive', true)),
      next: () => this.runArticleEnd(() => { this.navigate(1); }),
      library: () => this.runArticleEnd(() => this.openLibrary()),
    });
    target.replaceChildren(this.root);
    this.empty('Reader'); this.syncNavigation();
    this.stopViewport = watchReaderViewport(this.root, host.visibleOverlays, host.isMobile === true);
    this.stopKeys = watchReaderKeys(this.root, () => host.shouldFocus ? host.shouldFocus() : this.root.contains(this.root.ownerDocument.activeElement), delta => this.navigate(delta), host.isMobile === true, (delta, move) => this.queueShortcut(delta, move), delta => this.canNavigate(delta));
    this.stopEink = host.onEinkChange?.(() => {
      if (!this.disposed && this.active) void this.open(this.active, { ...this.getState(), subpath: undefined, readingPosition: this.stopReader.getPosition?.(), focus: false });
    }) ?? (() => {});
    this.stopActive = host.onActiveChange?.(() => {
      // Leaving and returning to a native leaf must not revive a pending finish.
      if (host.shouldFocus?.() === false) this.navigationRevision++;
    }) ?? (() => {});
    this.unsubscribe = controller.subscribe(() => { void this.refresh(); }); void this.refresh();
  }
  getArticle(): Article | undefined { return this.disposed ? undefined : this.article; }
  /** A path alone can be reused after deletion. Native dialogs bind to this mount
   * and the repository's in-memory path generation, not persisted article IDs. */
  articleToken(): string | undefined {
    return this.article && !this.disposed
      ? JSON.stringify([this.active, this.openRevision, this.controller.repository.articleGeneration(this.active)]) : undefined;
  }
  canOpenMarkdown(): boolean { return !this.disposed && !!this.active; }
  async openMarkdown(): Promise<void> {
    const path = this.canOpenMarkdown() ? this.active : '';
    if (path) { this.navigationRevision++; await (this.host.openMarkdown ? this.host.openMarkdown(path) : this.host.openNote(path)); }
  }
  getState(): ReaderState {
    const readingPosition = this.stopReader.getPosition?.();
    // Both reading modes serialize text anchors; pixels are legacy fallback only.
    // A current text position supersedes the original deep link after navigation.
    return { file: this.active || undefined, queue: this.readingQueue, subpath: readingPosition ? undefined : this.subpath,
      scrollTop: this.pane.querySelector<HTMLElement>('.r2-reader-scroll')?.scrollTop ?? 0, ...(readingPosition ? { readingPosition } : {}) };
  }
  private navigation() { const articles = this.readingQueue ? this.items.filter(article => article.status === this.readingQueue) : []; return { articles, index: articles.findIndex(article => article.path === this.active) }; }
  canNavigate(delta: number): boolean { const { articles, index } = this.navigation(); return !this.disposed && index >= 0 && !!articles[index + delta]; }
  navigate(delta: number) {
    if (delta === 0) { if (this.active) void this.open(this.active, { queue: this.readingQueue, focus: false }); return; }
    const { articles, index } = this.navigation(); if (this.canNavigate(delta)) void this.open(articles[index + delta].path, { queue: this.readingQueue });
  }
  canNavigateQueue(delta: number): boolean {
    const index = this.readingQueue ? QUEUES.indexOf(this.readingQueue) : -1;
    return !this.disposed && Math.abs(delta) === 1 && index >= 0 && !!QUEUES[index + delta];
  }
  async navigateQueue(delta: number): Promise<void> {
    if (!this.canNavigateQueue(delta)) return;
    const queue = QUEUES[QUEUES.indexOf(this.readingQueue!) + delta];
    const navigation = ++this.navigationRevision; this.articleEndError = undefined;
    // Select immediately so rapid taps advance from the new queue, even while loading.
    this.openRevision++; this.revision++; this.initialized = true;
    const scroll = this.pane.querySelector<HTMLElement>('.r2-reader-scroll');
    if (this.active) this.rememberPosition(this.active, scroll ?? undefined, this.stopReader.getPosition?.());
    this.disposeMount();
    this.active = ''; this.article = undefined; this.subpath = undefined; this.snapshot = '';
    this.readingQueue = queue;
    this.empty('Opening ' + queueLabel(queue) + '…'); this.syncNavigation(); this.host.onStateChange?.();
    try {
      const items = await this.controller.repository.listArticles();
      if (this.disposed || navigation !== this.navigationRevision) return;
      this.items = items;
      const first = items.find(article => article.status === queue);
      if (first) { await this.load(first.path, { queue }); return; }
      this.empty('No articles in ' + queueLabel(queue) + '.'); this.syncNavigation(); this.host.onStateChange?.();
    } catch (error) {
      if (this.disposed || navigation !== this.navigationRevision) return;
      this.empty(messageOf(error)); this.syncNavigation();
    }
    if (this.host.shouldFocus?.() !== false) this.pane.querySelector<HTMLElement>('.r2-article-title')?.focus({ preventScroll: true });
  }
  private queueShortcut(delta: number, move: boolean): boolean {
    if (this.disposed || !this.initialized) return false;
    if (move && (!this.article || this.moving)) {
      this.host.notify?.(this.moving ? 'An article move is already in progress.' : 'No article to move.'); return true;
    }
    if (move && !this.article!.status) { this.host.notify?.('This article is not in a queue.'); return true; }
    const current = move ? this.article!.status! : this.readingQueue;
    if (!current) { this.host.notify?.('This article is not in a queue.'); return true; }
    const queue = QUEUES[QUEUES.indexOf(current) + delta];
    if (!queue) { this.host.notify?.('Already at the ' + (delta < 0 ? 'first' : 'last') + ' queue: ' + queueLabel(current) + '.'); return true; }
    if (move) {
      void this.move(queue).then(() => { if (!this.disposed) this.host.notify?.('Moved to ' + queueLabel(queue) + '.'); })
        .catch(error => { if (!this.disposed) this.host.notify?.(messageOf(error)); });
      return true;
    }
    this.readingQueue = queue; this.articleEndError = undefined;
    const first = this.items.find(article => article.status === queue);
    if (first) { void this.open(first.path, { queue }); this.syncNavigation(); }
    else {
      const scroll = this.pane.querySelector<HTMLElement>('.r2-reader-scroll');
      if (this.active) this.rememberPosition(this.active, scroll ?? undefined, this.stopReader.getPosition?.());
      // An empty queue is navigation too: invalidate pending loads and move advancement.
      this.navigationRevision++; this.openRevision++; this.disposeMount(); this.stopReader = () => {};
      this.active = ''; this.article = undefined; this.subpath = undefined;
      this.empty('No articles in ' + queueLabel(queue) + '.'); this.syncNavigation(); this.host.onStateChange?.();
      if (this.host.shouldFocus?.() !== false) this.pane.querySelector<HTMLElement>('.r2-article-title')?.focus({ preventScroll: true });
    }
    this.host.notify?.('Queue: ' + queueLabel(queue) + (first ? '.' : ' (empty).'));
    return true;
  }
  private runArticleEnd(action: () => void | Promise<void>): void | Promise<void> {
    if (this.disposed || !this.article || this.moving) return;
    if (this.stopReader.canLeave?.() === false) {
      this.articleEndError = 'An annotation is unfinished or failed. Wait for saving to finish, or resolve the error above and retry.'; this.syncNavigation(); return;
    }
    this.articleEndError = undefined; this.syncNavigation();
    return action();
  }
  private syncNavigation() {
    // Only the source of a footer finish is locked, including its renamed mount.
    this.stopReader.setNavigationBusy?.(!this.disposed && !!this.moving?.finish && this.active === this.moving.path);
    if (this.disposed || !this.articleEnd || !this.article) return;
    if (!this.article.status || !this.readingQueue) { this.articleEnd.element.remove(); return; }
    const { articles, index } = this.navigation();
    this.articleEnd.update({ article: this.article, queue: this.readingQueue,
      next: index >= 0 ? articles[index + 1] : undefined, busy: !!this.moving, error: this.articleEndError });
    // The mount owns placement inside the scrolling reading page.
    this.stopReader.setArticleEnd?.(this.articleEnd.element);
  }
  async openLibrary(queue = this.readingQueue ?? 'inbox'): Promise<void> {
    if (this.disposed) return;
    const navigation = ++this.navigationRevision;
    const current = () => !this.disposed && navigation === this.navigationRevision && this.host.shouldFocus?.() !== false;
    try {
      const articles = await this.controller.repository.listArticles(); if (!current()) return;
      this.host.pickArticle?.(articles.filter(article => article.status === queue), queue, path => { if (current()) void this.open(path, { queue }); });
    } catch (error) {
      if (!current()) return;
      this.articleEndError = messageOf(error); this.syncNavigation(); this.host.notify?.(messageOf(error));
    }
  }
  private snapshotOf(article: Article) { return JSON.stringify([article.title, article.body, article.content, article.error, article.extractor, article.highlights]); }
  async refresh(): Promise<void> {
    const revision = ++this.revision;
    try {
      const items = await this.controller.repository.listArticles(); if (this.disposed || revision !== this.revision) return;
      this.items = items;
      if (!this.initialized) { this.initialized = true; if (!this.active && this.host.autoOpen !== false) { await this.openDefault(); return; } }
      let current = items.find(article => article.path === this.active);
      if (!current && this.active && this.article && !this.article.status && !this.moving) {
        try { current = await this.controller.repository.getArticle(this.active); }
        catch { /* A deleted or no-longer-article note is handled below. */ }
        if (this.disposed || revision !== this.revision) return;
      }
      if (current) {
        const titleChanged = this.article?.title !== current.title;
        this.article = current;
        // Metadata titles must update native chrome even while a selection
        // deliberately postpones re-rendering the article body.
        if (titleChanged) this.host.onStateChange?.();
      }
      // Queue-only changes update the preview even during an active selection.
      this.syncNavigation();
      if (current && this.snapshotOf(current) !== this.snapshot && this.pane.querySelector('.r2-reader')) {
        // Inline writes adopt into the existing mount, including during native moves.
        // Only a fallback remount waits for the operation to finish.
        if (this.stopReader.update?.(current)) this.snapshot = this.snapshotOf(current);
        else if (this.moving?.path !== current.path && this.root.ownerDocument.getSelection()?.isCollapsed !== false)
          void this.load(current.path, { queue: this.readingQueue, subpath: this.subpath, focus: false });
      }
      if (!current && this.active && this.article && this.moving?.path !== this.active) {
        this.disposeMount(); this.article = undefined;
        this.empty('This article is no longer available.');
      }
    } catch (error) { if (!this.disposed && revision === this.revision) this.host.notify?.(messageOf(error)); }
  }
  async openDefault(): Promise<void> {
    const navigation = this.navigationRevision;
    const items = await this.controller.repository.listArticles(); if (this.disposed || this.active || navigation !== this.navigationRevision) return;
    const first = items.find(article => article.status === 'inbox') ?? items[0]; if (first) await this.open(first.path);
  }
  async open(path: string, options: ReaderOpenOptions = {}): Promise<void> {
    this.navigationRevision++; this.articleEndError = undefined; await this.load(path, options);
  }
  /** Native rename is already committed. Record the destination synchronously so
   * close/unload can flush it before the deferred repository/UI refresh finishes.
   * Old annotation closures keep their original generation and remain invalid. */
  remapPosition(from: string, to: string): void {
    if (this.disposed || from === to) return;
    // Observe queue renames at the early native event too: deferred storage work
    // may finish after our final list already contains an idless next note's new path.
    this.revision++; this.remapQueuePaths(from, to);
    if (this.active !== from) { this.syncNavigation(); return; }
    this.openRevision++; this.recordedRenames.set(from, to);
    this.stopReader.remapPosition?.(to); this.active = to;
    if (this.article) this.article = { ...this.article, path: to, status: statusFromPath(to) ?? this.article.status };
    this.syncNavigation(); this.host.onStateChange?.();
  }
  private remapQueuePaths(from: string, to: string): void {
    this.items = this.items.map(article => article.path === from ? { ...article, path: to, status: statusFromPath(to) ?? article.status } : article);
    if (this.moving) {
      if (this.moving.path === from) this.moving.path = to;
      for (const [original, latest] of this.moving.paths) if (latest === from) {
        this.moving.paths.set(original, to);
        this.moving.generations.set(original, this.controller.repository.articleGeneration(to));
      }
    }
  }
  /** A committed rename is not navigation: retain origin queue and move advancement. */
  remapPath(from: string, to: string): void {
    if (this.disposed || from === to) return;
    const recorded = this.recordedRenames.get(from) === to; this.recordedRenames.delete(from);
    this.revision++; // Ignore list reads started before the rename.
    if (this.positions.has(from)) { this.positions.set(to, this.positions.get(from)!); this.positions.delete(from); }
    if (this.readingPositions.has(from)) { this.readingPositions.set(to, this.readingPositions.get(from)!); this.readingPositions.delete(from); }
    if (this.positionGenerations.has(from)) {
      this.positionGenerations.set(to, this.controller.repository.articleGeneration(to)); this.positionGenerations.delete(from);
    }
    this.remapQueuePaths(from, to);
    if (this.active !== from && !(recorded && this.active === to)) { this.syncNavigation(); return; }
    const state = this.getState();
    if (!this.moving) state.queue = statusFromPath(to) ?? state.queue;
    this.stopReader.remapPosition?.(to);
    this.active = to;
    if (this.article) this.article = { ...this.article, path: to, status: statusFromPath(to) ?? this.article.status };
    // Dispose old-path highlight/menu closures immediately, including pending selections.
    void this.load(to, { ...state, focus: false }); this.host.onStateChange?.();
  }
  private async load(path: string, options: ReaderOpenOptions = {}): Promise<void> {
    if (this.disposed || options.isCurrent?.() === false) return;
    const scroll = this.pane.querySelector<HTMLElement>('.r2-reader-scroll');
    if (this.active) this.rememberPosition(this.active, scroll ?? undefined, this.stopReader.getPosition?.());
    const revision = ++this.openRevision, navigation = this.navigationRevision; this.active = path; this.article = undefined; this.subpath = options.subpath;
    // Publish native file identity before loading so another click can reuse it.
    this.host.onStateChange?.();
    this.disposeMount(); this.stopReader = () => {}; this.pane.replaceChildren(element('p', 'r2-loading', 'Opening article…'));
    try {
      const article = await this.controller.repository.getArticle(path);
      if (this.disposed || revision !== this.openRevision || options.isCurrent?.() === false) return;
      this.article = article; this.readingQueue = options.queue ?? article.status; this.snapshot = this.snapshotOf(article);
      this.stopReader = mountReader(this.pane, article, this.controller, this.host, () => this.navigate(0));
      this.syncNavigation(); // Attach completion before restoring the scroll position.
      const scroller = this.pane.querySelector<HTMLElement>('.r2-reader-scroll');
      if (scroller) { scroller.scrollTop = options.scrollTop ?? (this.rememberedPosition(path) ? this.positions.get(path) : undefined) ?? 0; scroller.addEventListener('scroll', () => this.host.onStateChange?.(), { passive: true }); }
      const position = options.readingPosition ?? (!options.subpath
        ? (this.rememberedPosition(path) ? this.readingPositions.get(path) : undefined) ?? article.readingPosition : undefined);
      if (position) this.stopReader.restorePosition?.(position);
      const focus = navigation === this.navigationRevision && options.focus !== false && this.host.shouldFocus?.() !== false;
      if (!(options.subpath && focusReaderTarget(this.pane, article, options.subpath, focus, this.stopReader.revealRange)) && focus) this.pane.querySelector<HTMLElement>('.r2-article-title')?.focus({ preventScroll: true });
      this.syncNavigation(); this.host.onStateChange?.(); this.controller.scheduleAcquisition();
    } catch (error) { if (!this.disposed && revision === this.openRevision && options.isCurrent?.() !== false) this.empty(messageOf(error)); }
  }
  async move(destination: ArticleStatus): Promise<void> { await this.moveArticle(destination); }
  private nextSurvivor(order: Article[], remaining: Article[], paths: Map<string, string>, generations: Map<string, number>): Article | undefined {
    for (const article of order) {
      const path = paths.get(article.path) ?? article.path;
      // A rename is recorded by remapQueuePaths; a deleted/recreated filename is
      // not the same browsing item even when both articles have an empty ID.
      if (this.controller.repository.articleGeneration(path) !== generations.get(article.path)) continue;
      const exact = remaining.find(candidate => candidate.path === path);
      if (exact) return exact;
    }
    return undefined;
  }
  private async moveArticle(destination: ArticleStatus, finish = false): Promise<void> {
    const path = this.active, article = this.article;
    if (this.disposed || !article?.status || this.moving || article.status === destination) return;
    const queue = this.readingQueue ?? article.status, before = this.navigation();
    const operation = { path, navigation: this.navigationRevision, finish,
      paths: new Map(before.articles.map(item => [item.path, item.path])),
      generations: new Map(before.articles.map(item => [item.path, this.controller.repository.articleGeneration(item.path)])) }; this.moving = operation;
    const sourceGeneration = this.controller.repository.articleGeneration(path);
    const current = () => !this.disposed && this.active === operation.path && this.readingQueue === queue && this.navigationRevision === operation.navigation;
    this.articleEndError = undefined; this.syncNavigation();
    try {
      await this.flushPosition();
      // Footer intent can expire while position persistence yields. Native commands
      // retain their existing contract: finish the requested move, but do not advance
      // over newer navigation. Drain retired mounts in either case.
      if (finish) {
        if (!current() || operation.path !== path || this.article?.path !== path ||
          this.controller.repository.articleGeneration(path) !== sourceGeneration || this.host.shouldFocus?.() === false) return;
        if (this.stopReader.canLeave?.() === false) {
          this.articleEndError = 'An annotation is unfinished or failed. Wait for saving to finish, or resolve the error above and retry.'; return;
        }
      }
      const moved = await this.controller.move(path, destination);
      this.remapPath(path, moved.path); // Also works with adapters without native vault events.
      let items: Article[] = [];
      for (let attempt = 0; ; attempt++) {
        const revision = this.revision;
        items = await this.controller.repository.listArticles();
        if (!current() || (finish && this.host.shouldFocus?.() === false)) return;
        // A native rename/refresh can invalidate a list that was already in flight.
        if (revision === this.revision) break;
        if (attempt >= 2) throw new Error('The reading list keeps changing. Open the reading list again to continue.');
      }
      this.items = items;
      const remaining = items.filter(article => article.status === queue);
      const forward = before.index >= 0 ? before.articles.slice(before.index + 1) : [];
      // Only native move commands retain the historical backwards fallback.
      const order = finish ? forward : [...forward, ...before.articles.slice(0, Math.max(0, before.index)).reverse()];
      const next = finish ? this.nextSurvivor(order, remaining, operation.paths, operation.generations)
        : order.find(article => remaining.some(candidate => candidate.path === article.path)) ?? remaining[0];
      if (next) { await this.open(next.path, { queue }); return; }
      this.disposeMount(); this.stopReader = () => {}; this.openRevision++; this.active = ''; this.article = undefined; this.subpath = undefined;
      const message = finish ? 'End of ' + queueLabel(queue) + ' queue.' : 'No more articles in ' + queueLabel(queue) + '.';
      this.empty(message); this.syncNavigation(); this.host.onStateChange?.();
      if (this.host.shouldFocus?.() !== false) this.pane.querySelector<HTMLElement>('.r2-article-title')?.focus({ preventScroll: true });
      if (finish && !this.disposed && this.navigationRevision === operation.navigation && !this.active && this.host.shouldFocus?.() !== false) {
        this.host.notify?.(message); await this.openLibrary(queue);
      }
    } catch (error) {
      if (current()) { this.articleEndError = messageOf(error); this.syncNavigation(); }
      else if (finish) this.host.notify?.(messageOf(error)); // Never lose a write failure after the user leaves.
      if (!finish) throw error;
    } finally {
      if (this.moving === operation) { this.moving = undefined; this.syncNavigation(); }
    }
  }
  private empty(message: string) { const heading = element('h1', 'r2-article-title', message); heading.tabIndex = -1; this.pane.replaceChildren(heading); }
  destroy(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true; this.openRevision++; this.unsubscribe(); this.disposeMount();
      this.stopViewport(); this.stopKeys(); this.stopEink(); this.stopActive(); this.root.remove();
    }
    return this.flushPosition();
  }
}
