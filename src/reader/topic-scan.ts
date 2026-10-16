import type { ArticleInfo } from '../core/model';
type ScanResult = { paths: string[]; uncertain: number };
type PendingScan = {
  run: () => Promise<ScanResult>;
  resolve: (result: ScanResult) => void;
  reject: (error: unknown) => void;
  detach: () => void;
};

/** Hold native slots until settlement; retain at most one replaceable pending request. */
export class TopicScanner {
  private active = false;
  private pending?: PendingScan;
  scan<File extends { path: string; stat: { mtime: number; size: number } }>(
    articles: readonly ArticleInfo[],
    options: Parameters<typeof scanTopicArticles<File>>[1],
  ): Promise<ScanResult> {
    if (options.signal.aborted) return Promise.resolve({ paths: [], uncertain: 0 });
    return new Promise((resolve, reject) => {
      const cancelPending = () => {
        if (this.pending !== job) return;
        this.pending = undefined;
        job.detach();
        job.resolve({ paths: [], uncertain: 0 });
      };
      const job: PendingScan = {
        run: () =>
          options.signal.aborted
            ? Promise.resolve({ paths: [], uncertain: 0 })
            : scanTopicArticles(articles, options),
        resolve,
        reject,
        detach: () => options.signal.removeEventListener('abort', cancelPending),
      };
      if (this.active) {
        const replaced = this.pending;
        this.pending = job;
        replaced?.detach();
        replaced?.resolve({ paths: [], uncertain: 0 });
        options.signal.addEventListener('abort', cancelPending, { once: true });
      } else this.start(job);
    });
  }
  private start(job: PendingScan): void {
    this.active = true;
    job.detach();
    void Promise.resolve()
      .then(job.run)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active = false;
        const next = this.pending;
        this.pending = undefined;
        if (next) this.start(next);
      });
  }
}

/** A disposable, bounded read model; never acquires content or writes reading state. */
export async function scanTopicArticles<
  File extends { path: string; stat: { mtime: number; size: number } },
>(
  articles: readonly ArticleInfo[],
  options: {
    signal: AbortSignal;
    file(path: string): File | undefined;
    read(file: File): Promise<string>;
    metadataMatch(article: ArticleInfo): boolean;
    bodyMatch(raw: string, article: ArticleInfo): boolean;
  },
): Promise<{ paths: string[]; uncertain: number }> {
  const matches = new Set<string>();
  let cursor = 0;
  let uncertain = 0;
  const worker = async () => {
    while (!options.signal.aborted && cursor < articles.length) {
      const article = articles[cursor++];
      if (options.metadataMatch(article)) {
        matches.add(article.path);
        continue;
      }
      const file = options.file(article.path);
      if (!file) continue;
      const { mtime, size } = file.stat;
      try {
        const raw = await options.read(file);
        if (options.signal.aborted) return;
        if (
          file.path !== article.path ||
          options.file(article.path) !== file ||
          file.stat.mtime !== mtime ||
          file.stat.size !== size
        ) {
          uncertain++;
          continue;
        }
        if (options.bodyMatch(raw, article)) matches.add(article.path);
      } catch {
        if (!options.signal.aborted) uncertain++;
      }
    }
  };
  const workers = await Promise.allSettled([worker(), worker()]);
  const failure = workers.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return {
    paths: options.signal.aborted
      ? []
      : articles.filter((a) => matches.has(a.path)).map((a) => a.path),
    uncertain,
  };
}
