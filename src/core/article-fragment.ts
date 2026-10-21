export interface ArticleFragmentIntent<File extends { path: string }> {
  readonly file: File;
  readonly path: string;
  readonly subpath: string;
  readonly expires: number;
}

/** Native View state does not retain an incoming subpath. Remember only a recent
 * explicit internal-link intent, never infer one from the native cursor/scroll.
 * This is transient navigation state, not a persisted reading-position field. */
export class ArticleFragmentIntents<File extends { path: string }> {
  private pending?: ArticleFragmentIntent<File>;
  constructor(private readonly clock: () => number = Date.now) {}

  observe(
    href: string,
    sourcePath: string,
    resolve: (path: string, source: string) => File | undefined,
  ): void {
    this.clear();
    if (href.length > 4096 || /[\r\n\0\\]/u.test(href)) return;
    const at = href.indexOf('#');
    if (at < 0) return;
    let subpath: string;
    try {
      subpath = decodeURIComponent(href.slice(at));
    } catch {
      return;
    }
    if (!/^#\^[a-zA-Z0-9-]+$/u.test(subpath)) return;
    const raw = href.slice(0, at);
    if (/^[a-z][a-z\d+.-]*:/iu.test(raw) || raw.startsWith('//')) return;
    let path = raw.replace(/^\//u, '') || sourcePath;
    if (!path) return;
    let file: File | undefined;
    try {
      file = resolve(path, sourcePath);
    } catch {
      return;
    }
    if (!file && path.includes('%')) {
      try {
        path = decodeURIComponent(path);
      } catch {
        return;
      }
      if (/[\r\n\0\\#]/u.test(path) || /^[a-z][a-z\d+.-]*:/iu.test(path) || path.startsWith('//'))
        return;
      try {
        file = resolve(path, sourcePath);
      } catch {
        return;
      }
    }
    if (file) this.pending = { file, path: file.path, subpath, expires: this.clock() + 10_000 };
  }

  peek(file: File): ArticleFragmentIntent<File> | undefined {
    const intent = this.pending;
    if (intent && (this.clock() >= intent.expires || intent.file.path !== intent.path))
      this.clear();
    return this.pending?.file === file ? this.pending : undefined;
  }

  current(intent: ArticleFragmentIntent<File>): boolean {
    return this.peek(intent.file) === intent;
  }

  finish(intent: ArticleFragmentIntent<File>): void {
    if (this.pending === intent) this.clear();
  }

  clear(): void {
    this.pending = undefined;
  }
}
