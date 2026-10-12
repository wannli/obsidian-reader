import type { Article, ArticleStatus, CompactAnchor, Feed, HttpGet, ReaderSettings } from './types';
import { ReaderRepository } from './storage/repository';
import { extractArticle } from './ingest/extract';
import { parseFeed } from './ingest/feed';
import { normalizeUrl } from './ingest/url';
import { isAcquisitionUrl } from './acquisition-url';
import { StaleArticleWriteError } from './storage/preconditions';
import { EditorWriteDeferredError } from './editor-transaction';
import { expiredStreamItem, streamCutoff } from './stream-age';

export function acquisitionState(article: Article, dummy: boolean): 'ready' | 'protected' | 'pending' {
  // Notes without canonical folder identity remain readable, never auto-acquired.
  if (!article.status || !isAcquisitionUrl(article.url)) return 'ready';
  if (article.content === 'protected' || article.highlights.length || article.extractor === 'manual') return 'protected';
  if (article.extractor === 'defuddle' || article.extractor === 'feed' || (dummy && (article.extractor === 'dummy' || (article.extractor === 'summary' && !!article.body.trim())))) return 'ready';
  return 'pending';
}

export class ReaderController {
  private tasks = new Set<Promise<unknown>>();
  private listeners = new Set<() => void>();
  private stopped = false;
  private fetching = new Map<string, Promise<Article>>();
  private manual = new Map<string, Promise<Article>>();
  private extractionTail: Promise<unknown> = Promise.resolve();
  private polling?: Promise<void>;
  // Session-local scheduling only: no persisted timestamps or HTTP validators.
  private feedAttempts = new Map<string, number>();
  private feedNetworkFailures = new Set<string>();
  private feedScheduleKey(feed: Feed): string { return JSON.stringify([feed.path, feed.url]); }
  private active = false;
  private online = typeof navigator === 'undefined' || navigator.onLine;
  private expediteNetworkRetry = false;
  private acquisitionTimer?: ReturnType<typeof setTimeout>;
  private vaultTimer?: ReturnType<typeof setTimeout>;
  private acquisitionTask?: Promise<void>;
  private acquisitionRequested = false;
  private failedUntil = new Map<string, number>();
  private deferredWrites = new Set<string>();
  message = '';
  constructor(readonly repository: ReaderRepository, readonly get: HttpGet, readonly settings: ReaderSettings, private readonly refreshEligibility: () => Promise<void> = async () => {}) {}
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed(): void { if (!this.stopped) for (const fn of this.listeners) fn(); }
  private run<T>(fn: () => Promise<T>, scheduleAcquisition = true): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Reader is closing. Please reopen it.'));
    const task = Promise.resolve().then(() => this.refreshEligibility()).then(fn); this.tasks.add(task);
    void task.finally(() => { this.tasks.delete(task); this.changed(); if (scheduleAcquisition) this.scheduleAcquisition(); }).catch(() => {});
    return task;
  }
  async articleRenamed(from: string, to: string): Promise<void> {
    await this.repository.articleRenamed(from, to);
    this.failedUntil.delete(from); this.failedUntil.delete(to);
    this.deferredWrites.delete(from); this.deferredWrites.delete(to);
    this.changed(); this.scheduleAcquisition();
  }
  async articleDeleted(path: string): Promise<void> {
    await this.repository.articleDeleted(path);
    this.failedUntil.delete(path); this.deferredWrites.delete(path);
    this.changed(); this.scheduleAcquisition();
  }
  vaultChanged(): void {
    if (this.stopped) return;
    clearTimeout(this.vaultTimer);
    this.vaultTimer = setTimeout(() => {
      this.vaultTimer = undefined;
      if (!this.stopped) {
        this.deferredWrites.clear();
        void this.run(async () => {
          const result = await this.repository.promoteAnnotatedStream(path => this.fetching.has(path) || this.manual.has(path));
          if (result.retained.length) this.message = `Stream promotion deferred for ${result.retained.length} notes; close Markdown editors or review move conflicts.`;
          else if (this.message.startsWith('Stream promotion deferred for ')) this.message = '';
        }).catch(error => { this.message = String(error); });
      }
    }, 180);
  }
  setActive(active: boolean): void {
    if (active && !this.active) this.deferredWrites.clear();
    this.active = active;
    if (active) this.scheduleAcquisition();
    else { clearTimeout(this.acquisitionTimer); this.acquisitionTimer = undefined; }
  }
  setOnline(online: boolean): void {
    if (online && !this.online) {
      this.expediteNetworkRetry = true; this.deferredWrites.clear();
      // Only transport failures retry on reconnect; HTTP/import errors keep their cadence.
      for (const key of this.feedNetworkFailures) this.feedAttempts.delete(key);
      this.feedNetworkFailures.clear();
    }
    this.online = online;
    if (online) this.scheduleAcquisition();
    else { clearTimeout(this.acquisitionTimer); this.acquisitionTimer = undefined; }
  }
  scheduleAcquisition(): void {
    if (this.stopped || !this.active || !this.online) return;
    this.acquisitionRequested = true;
    if (this.acquisitionTask || this.acquisitionTimer !== undefined) return;
    this.acquisitionTimer = setTimeout(() => {
      this.acquisitionTimer = undefined;
      if (this.stopped || !this.active || !this.online) return;
      const task = this.processAcquisition(); this.acquisitionTask = task;
      void task.catch(error => { this.message = String(error); this.changed(); }).finally(() => {
        this.acquisitionTask = undefined;
        if (this.acquisitionRequested) this.scheduleAcquisition();
      });
    }, 150);
  }
  private retryDue(article: Article): boolean {
    return !this.deferredWrites.has(article.path) && (this.failedUntil.get(article.path) ?? 0) <= Date.now() &&
      (!article.retryAfter || !Number.isFinite(Date.parse(article.retryAfter)) || Date.parse(article.retryAfter) <= Date.now());
  }
  private async processAcquisition(): Promise<void> {
    this.acquisitionRequested = false; await this.refreshEligibility();
    const priority: Record<ArticleStatus, number> = { inbox: 0, later: 1, feed: 2, archive: 3 };
    const expedite = this.expediteNetworkRetry; this.expediteNetworkRetry = false;
    const networkFailure = (article: Article) => expedite && /offline|network|timed?\s*out|failed to fetch|fetch failed|connection|HTTP 5\d\d/i.test(article.error ?? '');
    const candidates = (await this.repository.listArticles()).filter(article =>
      acquisitionState(article, this.settings.useDummyContent) === 'pending' && (this.retryDue(article) || networkFailure(article)),
    ).sort((a, b) => priority[a.status ?? 'archive'] - priority[b.status ?? 'archive']);
    for (const article of candidates.slice(0, 10)) {
      if (this.stopped || !this.active || !this.online) return;
      try {
        const result = await this.acquire(article.path, networkFailure(article));
        if (acquisitionState(result, this.settings.useDummyContent) === 'pending') this.failedUntil.set(article.path, Date.now() + 300000);
      }
      catch (error) { if (error instanceof EditorWriteDeferredError) { this.failedUntil.delete(article.path); this.deferredWrites.add(article.path); this.message = error.message; continue; } if (error instanceof StaleArticleWriteError) { this.failedUntil.delete(article.path); continue; } if (this.active && this.online) this.failedUntil.set(article.path, Date.now() + 300000); this.message = String(error); }
    }
    if (candidates.length > 10) this.acquisitionRequested = true;
  }
  async shutdown(): Promise<void> {
    this.stopped = true; this.setActive(false); clearTimeout(this.vaultTimer); this.listeners.clear();
    await Promise.allSettled([...this.tasks, ...(this.acquisitionTask ? [this.acquisitionTask] : [])]);
  }
  capture(url: string, title = ''): Promise<Article> {
    return this.run(async () => {
      if (!isAcquisitionUrl(url)) throw new Error('Enter a complete HTTP(S) URL, not a template placeholder.');
      const canonical = normalizeUrl(url.trim());
      return this.repository.createArticle({ title: title.trim() || new URL(canonical).hostname, url: canonical, status: 'inbox' });
    });
  }
  acquire(path: string, retry = false): Promise<Article> {
    const existing = this.fetching.get(path); if (existing) return existing;
    const generation = this.repository.articleGeneration(path);
    return this.queueExtraction(path, async () => {
      if (this.repository.articleGeneration(path) !== generation) throw new StaleArticleWriteError();
      const article = await this.repository.getArticle(path);
      const options = { expectedUrl: article.url, expectedBody: article.body, expectedRevision: article.revision, expectedGeneration: generation };
      const assertCurrent = () => { if (this.repository.articleGeneration(path) !== generation) throw new StaleArticleWriteError(); };
      assertCurrent();
      if (this.stopped || !this.online || acquisitionState(article, this.settings.useDummyContent) !== 'pending' || (!retry && !this.retryDue(article))) return article;
      let result: Awaited<ReturnType<typeof extractArticle>>;
      try { result = await extractArticle(article.url, this.get, this.settings.useDummyContent ? 'dummy' : 'defuddle'); }
      catch (error) {
        await this.refreshEligibility(); assertCurrent(); const latest = await this.repository.getArticle(path); if (!isAcquisitionUrl(latest.url) || latest.url !== article.url) throw new StaleArticleWriteError();
        await this.repository.setArticleError(path, String(error instanceof Error ? error.message : error), new Date(Date.now() + 300000).toISOString(), options);
        this.failedUntil.set(path, Date.now() + 300000); return this.repository.getArticle(path);
      }
      await this.refreshEligibility(); assertCurrent(); const latest = await this.repository.getArticle(path); if (!isAcquisitionUrl(latest.url) || latest.url !== article.url) throw new StaleArticleWriteError();
      const saved = await this.repository.saveContent(path, result.extractor === 'dummy' ? { ...result, title: article.title } : result, options); this.failedUntil.delete(path); this.deferredWrites.delete(path); return saved;
    });
  }
  private queueExtraction(path: string, work: () => Promise<Article>): Promise<Article> {
    const previous = this.extractionTail, task = this.run(() => previous.catch(() => {}).then(work));
    this.extractionTail = task; this.fetching.set(path, task);
    void task.finally(() => { if (this.fetching.get(path) === task) this.fetching.delete(path); }).catch(() => {}); return task;
  }
  isFetchingFullText(path: string): boolean { return this.manual.has(path); }
  fetchFullText(path: string): Promise<Article> {
    const busy = this.manual.get(path); if (busy) return busy;
    if (!this.online) return Promise.reject(new Error('Offline. Retry fetching full text when online.'));
    const generation = this.repository.articleGeneration(path);
    const task = this.queueExtraction(path, async () => {
      if (this.repository.articleGeneration(path) !== generation) throw new StaleArticleWriteError();
      const article = await this.repository.getArticle(path);
      if (this.repository.articleGeneration(path) !== generation) throw new StaleArticleWriteError();
      if (this.stopped || !this.online) throw new Error('Offline or closing. Retry fetching full text when online.');
      if (article.content === 'protected' || article.extractor === 'manual' || article.highlights.length) throw new Error('Cannot replace protected, authored or highlighted text. Open Markdown to review it.');
      if (!isAcquisitionUrl(article.url)) throw new Error('This article has no valid HTTP(S) source URL. Expand template placeholders before fetching.');
      // Already-real snapshots are a storage no-op, not a successful new fetch.
      if (article.extractor === 'defuddle') return article;
      try {
        const result = await extractArticle(article.url, this.get, 'defuddle'); await this.refreshEligibility();
        if (this.repository.articleGeneration(path) !== generation) throw new StaleArticleWriteError();
        const latest = await this.repository.getArticle(path);
        if (!isAcquisitionUrl(latest.url) || latest.url !== article.url) throw new StaleArticleWriteError();
        if (latest.extractor === 'defuddle') return latest;
        const saved = await this.repository.saveContent(path, result, { allowFeedReplacement: true, expectedUrl: article.url, expectedBody: article.body, expectedRevision: article.revision, expectedGeneration: generation });
        if (saved.body === article.body || !saved.body.includes(result.markdown) || saved.error?.startsWith('Snapshot protected:') || !saved.body.trim()) throw new Error('Text changed or gained highlights while fetching; the saved snapshot was preserved.');
        // Only the explicit action promotes Stream, and only after usable text is persisted.
        const completed = saved.status === 'feed' ? await this.repository.setStatus(saved.path, 'inbox') : saved;
        this.failedUntil.delete(path); this.deferredWrites.delete(path); return completed;
      } catch (error) { if (error instanceof StaleArticleWriteError || error instanceof EditorWriteDeferredError) this.failedUntil.delete(path); else this.failedUntil.set(path, Date.now() + 300000); if (error instanceof EditorWriteDeferredError) this.deferredWrites.add(path); throw error; }
    });
    this.manual.set(path, task); void task.finally(() => { if (this.manual.get(path) === task) this.manual.delete(path); }).catch(() => {}); return task;
  }
  assignTopics(path: string, delta: import('./storage/relationships').RelationshipDelta, expected?: import('./storage/relationships').RelationshipExpectation): Promise<Article> {
    return this.annotate(path, () => this.repository.updateArticleTopics(path, delta, expected));
  }
  assignAuthors(path: string, delta: import('./storage/relationships').RelationshipDelta, expected?: import('./storage/relationships').RelationshipExpectation): Promise<Article> {
    return this.annotate(path, () => this.repository.updateArticleAuthors(path, delta, expected));
  }
  move(path: string, status: ArticleStatus): Promise<Article> { return this.run(() => this.repository.setStatus(path, status)); }
  private annotate(path: string, write: () => Promise<Article>): Promise<Article> {
    const generation = this.repository.articleGeneration(path);
    return this.run(() => {
      if (this.repository.articleGeneration(path) !== generation) throw new StaleArticleWriteError();
      return write();
    });
  }
  highlight(path: string, quote: string, anchor: CompactAnchor): Promise<Article> {
    return this.annotate(path, () => this.repository.addHighlight(path, { quote, anchor }));
  }
  linkHighlight(path: string, id: string, target: string): Promise<Article> {
    return this.annotate(path, () => this.repository.setHighlightLink(path, id, target));
  }
  linkNode(path: string, id: string, node: import('./nodes-api').NodeResult | null, guard: () => void = () => {}): Promise<Article> {
    return this.annotate(path, () => this.repository.setNodeLink(path, id, node, guard));
  }
  deleteHighlight(path: string, id: string, removeLinked = false): Promise<Article> {
    return this.annotate(path, () => this.repository.deleteHighlight(path, id, removeLinked));
  }
  setLinkTarget(path: string, id: string, target: string): Promise<Article> {
    return this.annotate(path, () => this.repository.setLink(path, id, target));
  }
  unlink(path: string, id: string): Promise<Article> {
    return this.annotate(path, () => this.repository.deleteLink(path, id));
  }
  private async pruneStream(cutoff: number) {
    const result = await this.repository.cleanupStream(cutoff, path => this.fetching.has(path) || this.manual.has(path));
    for (const path of result.deleted) { this.failedUntil.delete(path); this.deferredWrites.delete(path); }
    const issues = result.retained.length ? [`Stream cleanup retained ${result.retained.length} protected, referenced or busy notes (or failed removals); review them manually.`] : [];
    return { ...result, issues };
  }
  cleanupStream(): Promise<string> {
    // Storage serializes cleanup with other mutations; keep queued/in-flight extraction
    // protected via pruneStream, without starting acquisition or feed polling here.
    return this.run(async () => {
      const result = await this.pruneStream(streamCutoff());
      this.message = `Stream cleanup: deleted ${result.deleted.length}; retained ${result.retained.length}; promoted ${result.promoted.length} to Inbox.`;
      if (result.issues.length) this.message += ' ' + result.issues.join(' · ');
      return this.message;
    }, false);
  }
  subscribeFeed(url: string): Promise<Feed> {
    return this.run(async () => {
      if (!isAcquisitionUrl(url)) throw new Error('Enter a complete HTTP(S) feed URL, not a template placeholder.');
      const cutoff = streamCutoff();
      this.message = (await this.pruneStream(cutoff)).issues.join(' · ');
      const canonical = normalizeUrl(url.trim());
      const response = await this.get(canonical);
      if (response.status < 200 || response.status >= 300) throw new Error('Feed returned HTTP ' + response.status);
      const parsed = parseFeed(response.text, canonical);
      const feed = await this.repository.createFeed(parsed.title, canonical);
      await this.importEntries(feed, parsed.entries, cutoff);
      this.feedAttempts.set(this.feedScheduleKey(feed), Date.now());
      this.feedNetworkFailures.delete(this.feedScheduleKey(feed));
      if (feed.error) await this.repository.updateFeed(feed.path, { error: '' });
      return feed;
    });
  }
  private async importEntries(feed: Feed, entries: ReturnType<typeof parseFeed>['entries'], cutoff: number): Promise<void> {
    for (const entry of entries.filter(entry => !expiredStreamItem(entry.published, undefined, cutoff)).slice(0, this.settings.maxFeedItems)) {
      await this.repository.createArticle({ title: entry.title, url: entry.url, feed: '[[' + feed.path.replace(/\.md$/, '') + ']]', feedPrefix: feed.prefix?.trim() || feed.title, published: entry.published, summary: entry.summary, status: 'feed', feedText: entry.feedText });
    }
  }
  refreshFeeds(force = true): Promise<void> {
    if (this.polling) return this.polling;
    const task = this.run(async () => {
      const cutoff = streamCutoff();
      this.message = 'Refreshing feeds…'; this.changed();
      const { issues } = await this.pruneStream(cutoff);
      const feeds = await this.repository.listFeeds();
      for (const feed of feeds.filter(f => f.enabled && isAcquisitionUrl(f.url))) {
        const key = this.feedScheduleKey(feed), attempted = this.feedAttempts.get(key);
        if (!force && attempted !== undefined && Date.now() - attempted < this.settings.pollMinutes * 60000) continue;
        this.feedAttempts.set(key, Date.now());
        try {
          let response;
          try { response = await this.get(feed.url); }
          catch (error) { this.feedNetworkFailures.add(key); throw error; }
          this.feedNetworkFailures.delete(key);
          if (response.status !== 304) {
            if (response.status < 200 || response.status >= 300) throw new Error('HTTP ' + response.status);
            await this.importEntries(feed, parseFeed(response.text, feed.url).entries, cutoff);
          }
          if (feed.error) await this.repository.updateFeed(feed.path, { error: '' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          issues.push(feed.title + ': ' + message);
          if (feed.error !== message) await this.repository.updateFeed(feed.path, { error: message });
        }
      }
      this.message = issues.length ? issues.join(' · ') : 'Feeds up to date';
    });
    this.polling = task; void task.finally(() => { this.polling = undefined; }).catch(() => {}); return task;
  }
}
