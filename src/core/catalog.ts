import {
  articleInfo,
  subscription,
  type ArticleInfo,
  type Properties,
  type Queue,
  type Subscription,
} from './model';

/** Metadata only. Bodies, rendered HTML, selections and acquisition state do not live here. */
export class Catalog {
  private articles = new Map<string, ArticleInfo>();
  private subscriptions = new Map<string, Subscription>();
  private urls = new Map<string, Set<string>>();
  private sorted = new Map<Queue | undefined, readonly ArticleInfo[]>();
  constructor(readonly root = 'Reading') {}

  update(path: string, properties: Properties): boolean {
    const next = articleInfo(path, properties, this.root),
      feed = subscription(path, properties);
    const previous = this.articles.get(path),
      oldFeed = this.subscriptions.get(path);
    if (
      JSON.stringify(previous) === JSON.stringify(next) &&
      JSON.stringify(oldFeed) === JSON.stringify(feed)
    )
      return false;
    this.remove(path);
    if (next) {
      this.articles.set(path, next);
      if (next.url) {
        let paths = this.urls.get(next.url);
        if (!paths) this.urls.set(next.url, (paths = new Set()));
        paths.add(path);
      }
      this.sorted.delete(next.queue);
    }
    if (feed) this.subscriptions.set(path, feed);
    return true;
  }
  remove(path: string): void {
    const article = this.articles.get(path);
    if (article) {
      this.sorted.delete(article.queue);
      const paths = this.urls.get(article.url);
      paths?.delete(path);
      if (!paths?.size) this.urls.delete(article.url);
    }
    this.articles.delete(path);
    this.subscriptions.delete(path);
  }
  rename(from: string, to: string, properties: Properties): void {
    this.remove(from);
    this.update(to, properties);
  }
  article(path: string): ArticleInfo | undefined {
    return this.articles.get(path);
  }
  feed(path: string): Subscription | undefined {
    return this.subscriptions.get(path);
  }
  findUrl(url: string): ArticleInfo | undefined {
    const path = this.urls.get(url)?.values().next().value;
    return path ? this.articles.get(path) : undefined;
  }
  feeds(): readonly Subscription[] {
    return [...this.subscriptions.values()];
  }
  values(): IterableIterator<ArticleInfo> {
    return this.articles.values();
  }
  get size(): number {
    return this.articles.size;
  }
  list(queue: Queue | undefined, query = '', offset = 0, limit = 50): readonly ArticleInfo[] {
    let rows = this.sorted.get(queue);
    if (!rows) {
      rows = [...this.articles.values()]
        .filter((article) => article.queue === queue)
        .sort(
          (a, b) =>
            b.date - a.date || a.title.localeCompare(b.title) || a.path.localeCompare(b.path),
        );
      this.sorted.set(queue, rows);
    }
    const search = query.trim().toLocaleLowerCase();
    if (search)
      rows = rows.filter((article) =>
        `${article.title}\n${article.url}`.toLocaleLowerCase().includes(search),
      );
    return rows.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
  }
  paths(queue: Queue): string[] {
    return this.list(queue, '', 0, this.size).map((article) => article.path);
  }
  /** Folder events may omit removed children; consult only this disposable metadata index. */
  pathsWithin(folder: string): string[] {
    const prefix = folder ? `${folder}/` : '';
    return [...this.articles.keys(), ...this.subscriptions.keys()].filter((path) =>
      path.startsWith(prefix),
    );
  }
}

/** A browsing snapshot doesn't change underneath the reader when feeds arrive or a note moves. */
export class ReadingQueue {
  private paths: string[] = [];
  private index = -1;
  open(paths: readonly string[], selected: string): void {
    this.paths = [...paths];
    this.index = this.paths.indexOf(selected);
  }
  get current(): string | undefined {
    return this.paths[this.index];
  }
  neighbour(direction: -1 | 1, exists: (path: string) => boolean): string | undefined {
    for (let i = this.index + direction; i >= 0 && i < this.paths.length; i += direction) {
      if (exists(this.paths[i])) return this.paths[i];
    }
  }
  select(path: string): void {
    this.index = this.paths.indexOf(path);
  }
  rename(from: string, to: string): void {
    this.paths = this.paths.map((path) => (path === from ? to : path));
  }
}
