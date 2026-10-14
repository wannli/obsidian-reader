import { type TFile } from 'obsidian';
import { extract } from '../content/extract';
import { feedMarkdown, parseFeed, type ParsedFeed } from '../content/feed';
import { createDocument, patchProperties, readDocument } from '../core/document';
import { hasAnnotations } from '../core/annotations';
import {
  filename,
  linkPath,
  monthCutoff,
  text,
  timestamp,
  vaultLink,
  webUrl,
  type Subscription,
} from '../core/model';
import { ArticleStore } from '../core/store';
import { SerialWrites, WorkQueue } from '../core/work';
import { assertSafeExternalText } from '../content/security';
import { Network } from './network';

class CancelledFeed extends Error {
  constructor() {
    super('Subscription import cancelled.');
  }
}
interface FeedGuard {
  check: () => void;
  validate: () => Promise<void>;
}

export class Ingestion {
  private network: Network;
  private ownsNetwork: boolean;
  private work = new WorkQueue(2);
  private feedCreates = new SerialWrites<string>();
  private active = true;
  private feedCache = new Map<string, { at: number; data: ParsedFeed }>();
  // Session-only invalidation: re-enabling never revives an old queued import.
  private feedVersions = new WeakMap<TFile, number>();
  // Joined Add Feed callers share work, but retain independent cancellation.
  private subscriptionClients = new Map<string, Set<symbol>>();
  constructor(
    private store: ArticleStore<TFile>,
    private notify: (message: string) => void,
    network?: Network,
  ) {
    this.network = network ?? new Network();
    this.ownsNetwork = network === undefined;
  }
  private assert(): void {
    if (!this.active) throw new Error('Reader has stopped.');
  }
  stop(): void {
    this.active = false;
    this.work.stop();
    if (this.ownsNetwork) this.network.stop();
    this.feedCache.clear();
  }
  private cancelFeed(file: TFile): void {
    this.feedVersions.set(file, (this.feedVersions.get(file) ?? 0) + 1);
  }
  private feedGuard(feed: Subscription, caller: () => void = () => {}): FeedGuard {
    const file = this.store.vault.file(feed.path),
      version = file ? (this.feedVersions.get(file) ?? 0) : 0;
    const check = () => {
      this.assert();
      caller();
      const indexed = this.store.catalog.feed(feed.path);
      if (
        !file ||
        file.path !== feed.path ||
        this.store.vault.file(feed.path) !== file ||
        (this.feedVersions.get(file) ?? 0) !== version ||
        !indexed?.enabled ||
        indexed.url !== feed.url
      )
        throw new CancelledFeed();
    };
    return {
      check,
      validate: async () => {
        check();
        const current = readDocument(await this.store.vault.read(file!)).properties;
        check();
        if (current.type !== 'feed' || current.url !== feed.url || current.enabled === false)
          throw new CancelledFeed();
      },
    };
  }
  private async loadFeed(
    url: string,
    fresh = false,
    guard: () => void = () => this.assert(),
  ): Promise<ParsedFeed> {
    this.assert();
    guard();
    url = webUrl(url);
    const cached = this.feedCache.get(url);
    if (!fresh && cached && Date.now() - cached.at < 300_000) return cached.data;
    const response = await this.network.get(
      url,
      'application/rss+xml, application/atom+xml, application/xml, text/xml',
      guard,
    );
    this.assert();
    guard();
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Feed returned HTTP ${response.status}.`);
    const data = parseFeed(response.text, url);
    this.feedCache.delete(url);
    this.feedCache.set(url, { at: Date.now(), data });
    while (this.feedCache.size > 5) this.feedCache.delete(this.feedCache.keys().next().value!);
    return data;
  }
  async subscribe(input: string, signal?: AbortSignal): Promise<void> {
    this.assert();
    if (signal?.aborted) throw new DOMException('Subscription import cancelled.', 'AbortError');
    const url = webUrl(input),
      client = Symbol();
    const clients = this.subscriptionClients.get(url) ?? new Set<symbol>();
    this.subscriptionClients.set(url, clients);
    clients.add(client);
    const check = () => {
      this.assert();
      if (!clients.size) throw new CancelledFeed();
    };
    const result = this.work.enqueue(`subscribe:${url}`, async () => {
      check();
      const exists = () =>
        this.store.catalog.feeds().some((feed) => {
          try {
            return webUrl(feed.url) === url;
          } catch {
            return false;
          }
        });
      if (exists()) return;
      const data = await this.loadFeed(url, true, check);
      check();
      if (exists()) return;
      const feed = await this.feedCreates.run('subscriptions', async () => {
        check();
        if (exists()) return;
        assertSafeExternalText(data.title);
        const base = filename(data.title, new Date()).replace(/^\d{6} /, '');
        for (let suffix = 1; suffix <= 1000; suffix++) {
          const name = suffix === 1 ? base : base.replace(/\.md$/, ` ${suffix}.md`);
          const path = `${this.store.folders.feeds}/${name}`;
          if (this.store.vault.exists?.(path) ?? this.store.vault.file(path)) continue;
          const properties = {
            type: 'feed',
            title: data.title,
            url,
            prefix: data.title,
            enabled: true,
          };
          const file = await this.store.vault.create(path, createDocument(properties), check);
          this.store.catalog.update(file.path, properties);
          return this.store.catalog.feed(file.path)!;
        }
        throw new Error('Too many subscriptions share this filename.');
      });
      if (feed) await this.refresh(feed, this.feedGuard(feed, check));
    });
    const clear = () => {
      if (this.subscriptionClients.get(url) === clients) this.subscriptionClients.delete(url);
    };
    void result.then(clear, clear); // Retain an empty group until shared work settles, so a new caller can join it.
    let onAbort = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => {
          clients.delete(client);
          reject(new DOMException('Subscription import cancelled.', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        void result.then(resolve, reject);
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      clients.delete(client);
    }
  }
  async setFeed(feed: Subscription, enabled: boolean): Promise<void> {
    this.assert();
    const file = this.store.vault.file(feed.path);
    if (!file) throw new Error('Subscription no longer exists.');
    const raw = await this.store.vault.process(file, (current) => {
      this.assert();
      const doc = readDocument(current);
      if (doc.properties.type !== 'feed' || text(doc.properties.url) !== feed.url)
        throw new Error('Subscription changed; reopen the list.');
      if (!enabled) this.cancelFeed(file);
      return patchProperties(current, { enabled });
    });
    this.store.catalog.update(file.path, readDocument(raw).properties);
  }
  async unsubscribe(feed: Subscription): Promise<void> {
    this.assert();
    const file = this.store.vault.file(feed.path);
    if (!file) return;
    const doc = readDocument(await this.store.vault.read(file));
    const validate = (current: string) => {
      this.assert();
      if (
        this.store.vault.file(feed.path) !== file ||
        file.path !== feed.path ||
        current !== doc.raw ||
        doc.properties.type !== 'feed' ||
        text(doc.properties.url) !== feed.url
      )
        throw new Error('Subscription changed; reopen the list.');
    };
    validate(doc.raw);
    this.cancelFeed(file);
    await this.store.vault.trash(file, validate);
    this.store.catalog.remove(feed.path);
  }
  async refreshAll(): Promise<void> {
    await Promise.all(
      this.store.catalog
        .feeds()
        .filter((feed) => feed.enabled)
        .map((feed) => {
          const guard = this.feedGuard(feed);
          return this.work
            .enqueue(`feed:${feed.path}`, () => this.refresh(feed, guard))
            .catch((error) => {
              if (this.active && !(error instanceof CancelledFeed))
                this.notify(`${feed.title}: ${String(error)}`);
            });
        }),
    );
  }
  private async refresh(feed: Subscription, guard = this.feedGuard(feed)): Promise<void> {
    try {
      await guard.validate();
      const data = await this.loadFeed(feed.url, true, guard.check);
      // Bound every import before dedup/age checks; later polls do not walk a backlog.
      const latest20 = [...data.items]
        .sort((a, b) => Date.parse(b.published ?? '') - Date.parse(a.published ?? ''))
        .slice(0, 20);
      for (const item of latest20) {
        guard.check();
        if (
          this.store.catalog.findUrl(item.url) ||
          (timestamp(item.published) ?? Infinity) < monthCutoff(new Date())
        )
          continue;
        await guard.validate();
        const body = await feedMarkdown(item);
        await guard.validate();
        await this.store.capture(
          {
            url: item.url,
            title: item.title,
            body,
            published: item.published,
            queue: 'Stream',
            feed: vaultLink(feed.path),
            prefix: feed.prefix,
          },
          new Date(),
          guard.validate,
        );
      }
      await this.feedError(feed, undefined, guard.check);
    } catch (error) {
      if (!this.active || error instanceof CancelledFeed) return;
      guard.check();
      await this.feedError(
        feed,
        error instanceof Error ? error.message : String(error),
        guard.check,
      );
      throw error;
    }
  }
  private async feedError(
    feed: Subscription,
    error?: string,
    guard: () => void = () => {},
  ): Promise<void> {
    const file = this.store.vault.file(feed.path);
    if (!file) return;
    const raw = await this.store.vault.process(file, (current) => {
      this.assert();
      guard();
      const doc = readDocument(current);
      if (
        doc.properties.type !== 'feed' ||
        doc.properties.url !== feed.url ||
        doc.properties.enabled === false
      )
        return current;
      return patchProperties(current, { error });
    });
    this.store.catalog.update(file.path, readDocument(raw).properties);
  }
  acquire(path: string, foreground = false): Promise<void> {
    return this.work.enqueue(
      `article:${path}`,
      async () => {
        this.assert();
        if (typeof navigator !== 'undefined' && !navigator.onLine) return;
        const snapshot = await this.store.read(path);
        if (hasAnnotations(snapshot.body, snapshot.properties)) return;
        try {
          const url = webUrl(text(snapshot.properties.url));
          let proof: string | undefined;
          if (snapshot.body.trim()) {
            const feedPath = linkPath(text(snapshot.properties.feed));
            const feed = feedPath
              ? (this.store.catalog.feed(feedPath) ?? this.store.catalog.feed(`${feedPath}.md`))
              : undefined;
            if (!feed) return;
            const source = (await this.loadFeed(feed.url)).items.find(
              (item) => item.url === url && item.excerpt,
            );
            if (!source) return;
            proof = await feedMarkdown(source);
            if (proof !== snapshot.body) return; // No ownership guess, even after restart.
          }
          this.assert();
          const result = await extract(url, async (source, accept) => {
            this.assert();
            // Shared native slots can outlive this generation. Guard both queued
            // dispatch and delivery before the extractor parses a response.
            const response = await this.network.get(source, accept, () => this.assert());
            this.assert();
            return response;
          });
          this.assert();
          assertSafeExternalText(result.title);
          assertSafeExternalText(result.markdown);
          await this.store.acquire(snapshot, result.markdown, result.title, proof);
        } catch (error) {
          if (this.active) {
            try {
              await this.store.error(
                snapshot,
                error instanceof Error ? error.message : String(error),
              );
            } catch {
              /* A newer note wins. */
            }
          }
          throw error;
        }
      },
      foreground,
    );
  }
}
