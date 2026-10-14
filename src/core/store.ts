import { Catalog } from './catalog';
import {
  acquireBody,
  ChangedNote,
  createDocument,
  patchProperties,
  readDocument,
  requireArticle,
  savePosition,
} from './document';
import { hasAnnotations } from './annotations';
import {
  filename,
  filenameDay,
  formatPublished,
  monthCutoff,
  publicationBefore,
  queueAt,
  queueFolder,
  timestamp,
  webUrl,
  type Properties,
  type Queue,
} from './model';
import { SerialWrites } from './work';
import { defaultFolders, type ReaderFolders } from './folders';

export interface NoteFile {
  path: string;
}
export interface VaultPort<File extends NoteFile> {
  file(path: string): File | undefined;
  /** Includes folders and host-specific aliases (such as case-insensitive names). */
  exists?(path: string): boolean;
  read(file: File): Promise<string>;
  create(path: string, content: string, guard?: () => void | Promise<void>): Promise<File>;
  process(file: File, update: (current: string) => string): Promise<string>;
  move(file: File, path: string, guard?: () => void): Promise<void>;
  /** Validate fresh bytes synchronously after the final read, immediately before native trash. */
  trash(file: File, validate: (current: string) => void): Promise<void>;
  assertWritable(file: File): void;
}
export interface Snapshot<File extends NoteFile> {
  file: File;
  path: string;
  raw: string;
  body: string;
  properties: Properties;
}

/** The only route to article mutations: one per-file queue, fresh bytes, then guarded commit. */
export class ArticleStore<File extends NoteFile> {
  readonly catalog: Catalog;
  private writes = new SerialWrites<File>();
  private creates = new SerialWrites<string>();
  // Filename ownership is session-local, never inferred from a hostname/date on disk.
  // After restart an unfinished capture keeps its original filename, even on success.
  private captures = new WeakMap<File, { path: string; date: Date }>();
  private active = true;
  readonly folders: ReaderFolders;
  constructor(
    readonly vault: VaultPort<File>,
    folders: ReaderFolders = defaultFolders,
  ) {
    this.catalog = new Catalog(folders);
    this.folders = this.catalog.folders;
  }
  dispose(): void {
    this.active = false;
    this.captures = new WeakMap();
  }
  /** Host path changes revoke ownership even if the file later returns to its original path. */
  noteRenamed(file: File): void {
    this.captures.delete(file);
  }
  private captureReceipt(file: File): { path: string; date: Date } | undefined {
    const receipt = this.captures.get(file);
    if (receipt && (file.path !== receipt.path || this.vault.file(receipt.path) !== file)) {
      this.captures.delete(file);
      return;
    }
    return receipt;
  }
  busy(file: File): boolean {
    return this.writes.busy(file);
  }
  private assert(file: File, expectedPath = file.path): void {
    if (!this.active) throw new Error('Reader has stopped.');
    this.captureReceipt(file); // Observed native/user renames permanently revoke the receipt.
    if (file.path !== expectedPath || this.vault.file(expectedPath) !== file)
      throw new ChangedNote();
    this.vault.assertWritable(file);
  }
  async read(path: string): Promise<Snapshot<File>> {
    if (!this.active) throw new Error('Reader has stopped.');
    const file = this.vault.file(path);
    if (!file) throw new ChangedNote('The article no longer exists.');
    this.captureReceipt(file);
    const raw = await this.vault.read(file),
      doc = requireArticle(raw);
    if (this.vault.file(path) !== file || file.path !== path) throw new ChangedNote();
    return { file, path, raw, body: doc.body, properties: doc.properties };
  }
  private async unique(folder: string, name: string, ownPath?: string): Promise<string> {
    for (let i = 0; i < 1_000; i++) {
      const path = `${folder}/${i ? name.replace(/\.md$/, ` ${i + 1}.md`) : name}`;
      // Keep an already matching name (including a numbered/case-only alias)
      // rather than treating the capture itself as a filename collision.
      if (ownPath && path.normalize('NFC').toLowerCase() === ownPath.normalize('NFC').toLowerCase())
        return ownPath;
      // The native adapter also checks folders/aliases and rejects late collisions.
      if (!(this.vault.exists ? this.vault.exists(path) : this.vault.file(path))) return path;
    }
    throw new Error('Too many articles share this filename.');
  }
  capture(
    input: {
      url: string;
      title?: string;
      body?: string;
      feed?: string;
      prefix?: string;
      published?: string;
      queue?: Queue;
    },
    now = new Date(),
    guard: () => void | Promise<void> = () => {},
  ): Promise<File> {
    const url = webUrl(input.url);
    return this.creates.run('articles', async () => {
      if (!this.active) throw new Error('Reader has stopped.');
      const existing = this.catalog.findUrl(url);
      if (existing) {
        const file = this.vault.file(existing.path);
        if (file) {
          this.captures.delete(file);
          return file;
        }
        this.catalog.remove(existing.path);
      }
      const publishedAt = timestamp(input.published);
      const published = formatPublished(input.published);
      // Keep the original instant for the UTC filename; only persisted publication loses seconds.
      const date = publishedAt === undefined ? now : new Date(publishedAt);
      const name = filename(
        input.title || new URL(url).hostname,
        date,
        input.prefix,
        publishedAt !== undefined,
      );
      const path = await this.unique(queueFolder(input.queue ?? 'Inbox', this.folders), name);
      const properties: Properties = { type: 'article', url };
      if (input.title?.trim()) properties.title = input.title.trim();
      if (published) properties.published = published;
      if (input.feed) properties.feed = input.feed;
      const raw = createDocument(properties, input.body?.trim() ? `\n${input.body.trim()}\n` : '');
      // Subscription validity may change while this capture waits behind another
      // create. Revalidate at the write boundary, never persist the guard.
      await guard();
      if (!this.active) throw new Error('Reader has stopped.');
      const file = await this.vault.create(path, raw, guard);
      if (
        this.active &&
        !input.title?.trim() &&
        !input.body?.trim() &&
        input.feed === undefined &&
        input.prefix === undefined &&
        input.published === undefined &&
        (input.queue ?? 'Inbox') === 'Inbox'
      ) {
        this.captures.set(file, { path, date: new Date(date.getTime()) });
      }
      this.catalog.update(path, properties);
      return file;
    });
  }
  private async commit(
    snapshot: Snapshot<File>,
    transform: (raw: string) => string,
  ): Promise<Snapshot<File>> {
    this.assert(snapshot.file, snapshot.path);
    if (transform(snapshot.raw) === snapshot.raw) {
      if ((await this.vault.read(snapshot.file)) !== snapshot.raw) throw new ChangedNote();
      return snapshot;
    }
    const raw = await this.vault.process(snapshot.file, (current) => {
      this.assert(snapshot.file, snapshot.path);
      if (current !== snapshot.raw) throw new ChangedNote();
      return transform(current);
    });
    const doc = requireArticle(raw);
    this.catalog.update(snapshot.file.path, doc.properties);
    return {
      file: snapshot.file,
      path: snapshot.file.path,
      raw,
      body: doc.body,
      properties: doc.properties,
    };
  }
  async move(
    snapshot: Snapshot<File>,
    queue: Queue,
    guard: () => void = () => {},
  ): Promise<Snapshot<File>> {
    // Invalidate at request time, including no-op/failed moves queued behind acquisition.
    this.captures.delete(snapshot.file);
    return this.writes.run(snapshot.file, () => this.moveNow(snapshot, queue, guard));
  }
  private async moveNow(
    snapshot: Snapshot<File>,
    queue: Queue,
    guard: () => void = () => {},
  ): Promise<Snapshot<File>> {
    guard();
    this.captures.delete(snapshot.file);
    this.assert(snapshot.file, snapshot.path);
    if ((await this.vault.read(snapshot.file)) !== snapshot.raw) throw new ChangedNote();
    if (queueAt(snapshot.path, this.folders) === queue) return snapshot;
    return this.creates.run('articles', async () => {
      const target = await this.unique(
        queueFolder(queue, this.folders),
        snapshot.path.split('/').pop()!,
      );
      this.assert(snapshot.file, snapshot.path);
      if ((await this.vault.read(snapshot.file)) !== snapshot.raw) throw new ChangedNote();
      this.assert(snapshot.file, snapshot.path);
      guard();
      await this.vault.move(snapshot.file, target, guard);
      this.catalog.rename(
        snapshot.path,
        target,
        readDocument(await this.vault.read(snapshot.file)).properties,
      );
      return this.read(target);
    });
  }
  /** Move first: interruption may leave a kept article, never a saved annotation still eligible for expiry. */
  annotate(snapshot: Snapshot<File>, transform: (raw: string) => string): Promise<Snapshot<File>> {
    return this.writes.run(snapshot.file, async () => {
      // Validate before moving: invalid selections/cancelled pickers must not cause any mutation.
      const proposed = transform(snapshot.raw);
      if (proposed === snapshot.raw) return snapshot;
      let current = snapshot;
      if (queueAt(current.path, this.folders) === 'Stream')
        current = await this.moveNow(current, 'Inbox');
      if (current.body !== snapshot.body)
        throw new ChangedNote(
          'The article moved to Inbox, but its text changed. Reopen it to retry the annotation.',
        );
      return this.commit(current, transform);
    });
  }
  position(path: string, marker: string): Promise<Snapshot<File>> {
    const file = this.vault.file(path);
    if (!file) return Promise.reject(new ChangedNote());
    return this.writes.run(file, async () =>
      this.commit(await this.read(file.path), (raw) => savePosition(raw, marker)),
    );
  }
  acquire(
    snapshot: Snapshot<File>,
    markdown: string,
    title: string,
    provenExcerpt?: string,
  ): Promise<Snapshot<File>> {
    return this.writes.run(snapshot.file, async () => {
      const receipt = this.captureReceipt(snapshot.file);
      const untitled = !Object.hasOwn(snapshot.properties, 'title');
      const saved = await this.commit(snapshot, (raw) => {
        const doc = requireArticle(raw);
        if (hasAnnotations(doc.body, doc.properties))
          throw new ChangedNote(
            'Article annotations are protected. Reader will not replace this content.',
          );
        return acquireBody(raw, snapshot.raw, markdown, untitled ? title : '', provenExcerpt);
      });
      try {
        if (
          !receipt ||
          !untitled ||
          snapshot.body.trim() ||
          Object.hasOwn(snapshot.properties, 'feed') ||
          !title.trim()
        )
          return saved;
        // Save first. Filename improvement is optional; a failed rename must not
        // lose acquired text or turn a successful acquisition into a retry.
        return await this.creates.run('articles', async () => {
          try {
            const folder = saved.path.slice(0, saved.path.lastIndexOf('/')),
              name = filename(title, receipt.date);
            const target = await this.unique(folder, name, saved.path);
            this.assert(saved.file, receipt.path);
            const current = await this.vault.read(saved.file);
            this.assert(saved.file, receipt.path);
            if (
              target !== saved.path &&
              this.captures.get(saved.file) === receipt &&
              snapshot.path === receipt.path &&
              current === saved.raw
            ) {
              await this.vault.move(saved.file, target);
            }
          } catch {
            /* Keep the saved body, including when a native move fails. */
          }
          // Native link-aware rename can also change this note's own links. Read
          // actual bytes/path, even if the host moved the file before rejecting.
          const current = await this.read(saved.file.path);
          if (current.file !== saved.file) throw new ChangedNote();
          this.catalog.rename(saved.path, current.path, current.properties);
          return current;
        });
      } finally {
        this.captures.delete(snapshot.file); // One successful acquisition, one chance.
      }
    });
  }
  error(snapshot: Snapshot<File>, message?: string): Promise<Snapshot<File>> {
    return this.writes.run(snapshot.file, () =>
      this.commit(snapshot, (raw) => patchProperties(raw, { error: message })),
    );
  }
  trash(snapshot: Snapshot<File>, guard: () => void = () => {}): Promise<void> {
    this.captures.delete(snapshot.file);
    return this.writes.run(snapshot.file, async () => {
      this.assert(snapshot.file, snapshot.path);
      await this.vault.trash(snapshot.file, (current) => {
        this.assert(snapshot.file, snapshot.path);
        if (current !== snapshot.raw) throw new ChangedNote();
        guard();
      });
      this.catalog.remove(snapshot.path);
    });
  }
  async expire(
    now = new Date(),
    inUse: (file: File) => boolean = () => false,
  ): Promise<{ deleted: number; retained: number; promoted: number }> {
    const result = { deleted: 0, retained: 0, promoted: 0 },
      cutoff = monthCutoff(now);
    for (const article of [...this.catalog.values()]) {
      if (!this.active) break;
      if (article.queue !== 'Stream') continue;
      // Cleanup needs bodies only for potentially expired notes. Fresh/undated
      // annotation promotion belongs to native change handling and reader writes.
      if (!publicationBefore(article.published, cutoff, filenameDay(article.path))) continue;
      const file = this.vault.file(article.path);
      if (!file || this.busy(file) || inUse(file)) {
        result.retained++;
        continue;
      }
      try {
        const snapshot = await this.read(article.path);
        if (hasAnnotations(snapshot.body, snapshot.properties)) {
          await this.move(snapshot, 'Inbox');
          result.promoted++;
        } else if (
          publicationBefore(snapshot.properties.published, cutoff, filenameDay(snapshot.path))
        ) {
          await this.trash(snapshot, () => {
            if (inUse(file)) throw new ChangedNote('Article is in use.');
          });
          result.deleted++;
        }
      } catch {
        result.retained++;
      }
    }
    return result;
  }
}
