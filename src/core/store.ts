import { Catalog } from './catalog';
import {
  acquireBody,
  ChangedNote,
  createDocument,
  patchProperties,
  readDocument,
  rememberDeletedUrl,
  requireArticle,
  replaceArticleBody,
  savePosition,
} from './document';
import { hasAnnotations } from './annotations';
import {
  deletedUrls,
  articleStatus,
  linkPath,
  text,
  filename,
  filenameDay,
  formatPublished,
  monthCutoff,
  publicationBefore,
  queueAt,
  queueStatus,
  timestamp,
  webUrl,
  type Properties,
  type Queue,
} from './model';
import { SerialWrites } from './work';
import { defaultFolders, type ReaderFolders } from './folders';
import { validateStatusFolders, type StatusFolders } from './status-folders';

export interface NoteFile {
  path: string;
}
export interface VaultPort<File extends NoteFile> {
  file(path: string): File | undefined;
  /** Source-aware native link resolution; missing/ambiguous destinations return undefined. */
  resolveLink?(linkpath: string, sourcePath: string): File | undefined;
  /** Includes folders and host-specific aliases (such as case-insensitive names). */
  exists?(path: string): boolean;
  read(file: File): Promise<string>;
  create(path: string, content: string, guard?: () => void | Promise<void>): Promise<File>;
  process(file: File, update: (current: string) => string): Promise<string>;
  move(file: File, path: string, guard?: (current: string) => void): Promise<void>;
  /** Validate fresh bytes synchronously after the final read, immediately before native trash. */
  trash(file: File, validate: (current: string) => void): Promise<void>;
  assertWritable(file: File, current?: string): void;
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
  private dogEarWrites = new SerialWrites<string>();
  private creates = new SerialWrites<string>();
  // Imports and explicit trash share a lane through the final native operation.
  private rss = new SerialWrites<string>();
  // Filename ownership is session-local, never inferred from a hostname/date on disk.
  // After restart an unfinished capture keeps its original filename, even on success.
  private captures = new WeakMap<File, { path: string; date: Date }>();
  private active = true;
  readonly folders: ReaderFolders;
  private statusFolders: StatusFolders = {};
  private ownRevisions: { file: File; raw: string }[] = [];
  private ownRevisionSize = 0;
  private statusFolderRevision = 0;
  private statusListeners = new Set<
    (file: File, status: unknown, raw: string, changed: boolean) => void
  >();
  observeStatusWrites(
    listener: (file: File, status: unknown, raw: string, changed: boolean) => void,
  ): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
  hasStatusFolder(status: unknown): boolean {
    const valid = articleStatus(status);
    return valid !== undefined && this.statusFolders[valid] !== undefined;
  }
  get statusFolderGeneration(): number {
    return this.statusFolderRevision;
  }
  /** Consume delayed metadata acknowledgement, independent of write-lane timing. */
  acknowledgeStatus(file: File, raw: string): boolean {
    const index = this.ownRevisions.findIndex((entry) => entry.file === file && entry.raw === raw);
    if (index < 0) return false;
    this.ownRevisionSize -= this.ownRevisions[index].raw.length;
    this.ownRevisions.splice(index, 1);
    return true;
  }
  private rememberRevision(file: File, raw: string): void {
    this.ownRevisions.push({ file, raw });
    this.ownRevisionSize += raw.length;
    // Exact-byte receipts are session-only and globally bounded (UTF-16 units).
    while (this.ownRevisions.length > 128 || this.ownRevisionSize > 4 * 1024 * 1024) {
      this.ownRevisionSize -= this.ownRevisions.shift()!.raw.length;
    }
  }
  setStatusFolders(folders: StatusFolders): void {
    this.statusFolders = validateStatusFolders(folders);
    this.statusFolderRevision++;
  }
  constructor(
    readonly vault: VaultPort<File>,
    folders: ReaderFolders = defaultFolders,
  ) {
    this.catalog = new Catalog(folders);
    this.folders = this.catalog.folders;
  }
  dispose(): void {
    this.active = false;
    this.ownRevisions = [];
    this.ownRevisionSize = 0;
    this.statusListeners.clear();
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
  async validate(snapshot: Snapshot<File>): Promise<void> {
    this.assert(snapshot.file, snapshot.path);
    const raw = await this.vault.read(snapshot.file);
    this.assert(snapshot.file, snapshot.path);
    if (raw !== snapshot.raw) throw new ChangedNote();
  }
  private async unique(folder: string, name: string, ownPath?: string): Promise<string> {
    for (let i = 0; i < 1_000; i++) {
      const path = `${folder ? `${folder}/` : ''}${i ? name.replace(/\.md$/, ` ${i + 1}.md`) : name}`;
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
    now = new Date(now.getTime()); // Freeze caller-owned capture time before queued work.
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
      const published = formatPublished(input.published) ?? formatPublished(now.toISOString());
      // Keep the original instant for the UTC filename; only persisted publication loses seconds.
      const date = publishedAt === undefined ? now : new Date(publishedAt);
      const name = filename(
        input.title || new URL(url).hostname,
        date,
        input.prefix,
        publishedAt !== undefined,
      );
      const initialStatus = queueStatus(input.queue ?? (input.feed ? 'Feed' : 'Inbox'));
      const path = await this.unique(
        this.statusFolders[initialStatus] ?? this.folders.articles,
        name,
      );
      const properties: Properties = {
        type: 'article',
        url,
        status: queueStatus(input.queue ?? (input.feed ? 'Feed' : 'Inbox')),
      };
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
  /** Only the host's live-create receipt authorizes this; never call from indexing/recovery. */
  publishNew(file: File, published: string, guard: () => void = () => {}): Promise<boolean> {
    return this.writes.run(file, async () => {
      guard();
      const path = file.path;
      this.assert(file, path);
      const raw = await this.vault.read(file);
      guard();
      this.assert(file, path);
      const doc = readDocument(raw);
      if (doc.properties.type !== 'article') return false;
      // Any authored value (even null, empty or invalid) is protected.
      if (Object.hasOwn(doc.properties, 'published')) return true;
      if (formatPublished(published) !== published)
        throw new Error('Invalid article creation time.');
      await this.commit(
        { file, path, raw, body: doc.body, properties: doc.properties },
        (current) => {
          guard();
          return patchProperties(current, { published });
        },
      );
      return true;
    });
  }
  /** RSS only: manual capture deliberately bypasses permanent suppression. */
  importFeed(
    input: Parameters<ArticleStore<File>['capture']>[0],
    now = new Date(),
    guard: () => void | Promise<void> = () => {},
    expected?: { url: string; check: () => void },
  ): Promise<File | undefined> {
    return this.rss.run('rss', async () => {
      const subscription = this.associatedSubscription(input.feed);
      if (!subscription) throw new ChangedNote('Subscription is required.');
      const { file, path } = subscription;
      const suppressed = async () => {
        await guard();
        const doc = readDocument(await this.vault.read(file));
        // No await between this cancellation check and validation of the same fresh snapshot.
        expected?.check();
        this.assert(file, path);
        if (
          doc.properties.type !== 'feed' ||
          doc.properties.enabled === false ||
          (expected && doc.properties.url !== expected.url)
        )
          throw new ChangedNote('Subscription changed; import cancelled.');
        return deletedUrls(doc.properties.deleted_urls).includes(webUrl(input.url));
      };
      if (await suppressed()) return;
      const blocked = new Error('Entry was deleted.');
      try {
        return await this.capture({ ...input, queue: 'Feed' }, now, async () => {
          // Also runs in the native create guard, after directory creation/other awaits.
          if (await suppressed()) throw blocked;
        });
      } catch (error) {
        if (error !== blocked) throw error;
      }
    });
  }
  private associatedSubscription(
    link: unknown,
    sourcePath?: string,
  ): { file: File; path: string } | undefined {
    if (link === undefined) return;
    const path = linkPath(text(link));
    if (!path) throw new ChangedNote('Invalid subscription link; article retained.');
    const file =
      sourcePath && this.vault.resolveLink
        ? this.vault.resolveLink(path, sourcePath)
        : (this.vault.file(path) ?? this.vault.file(path + '.md'));
    if (!file) throw new ChangedNote('Subscription is missing; article retained.');
    return { file, path: file.path };
  }
  private async commit(
    snapshot: Snapshot<File>,
    transform: (raw: string) => string,
  ): Promise<Snapshot<File>> {
    this.assert(snapshot.file, snapshot.path);
    if (transform(snapshot.raw) === snapshot.raw) {
      if ((await this.vault.read(snapshot.file)) !== snapshot.raw) throw new ChangedNote();
      this.assert(snapshot.file, snapshot.path);
      return snapshot;
    }
    const raw = await this.vault.process(snapshot.file, (current) => {
      this.assert(snapshot.file, snapshot.path);
      if (current !== snapshot.raw) throw new ChangedNote();
      const next = transform(current);
      this.rememberRevision(snapshot.file, next);
      return next;
    });
    const doc = requireArticle(raw);
    for (const listener of this.statusListeners)
      listener(
        snapshot.file,
        doc.properties.status,
        raw,
        snapshot.properties.status !== doc.properties.status,
      );
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
    relocate = true,
  ): Promise<Snapshot<File>> {
    guard();
    this.captures.delete(snapshot.file);
    const status = queueStatus(queue),
      folder = this.statusFolders[status],
      transition = snapshot.properties.status !== status;
    const saved = await this.commit(snapshot, (raw) => {
      guard();
      return patchProperties(raw, { status });
    });
    // YAML commits first: a failed relocation never makes a retained article disposable.
    // Selecting the same status is not a request to organize existing notes.
    if (!relocate || !transition || folder === undefined) return saved;
    return this.relocate(saved, status, folder, guard);
  }
  /** Only an observed status transition calls this; never startup or path reconciliation. */
  observedStatusChange(
    file: File,
    raw: string,
    valid: () => void = () => {},
    expectedStatus?: string,
  ): Promise<void> {
    return this.writes.run(file, async () => {
      valid();
      const current = await this.read(file.path);
      if (current.file !== file || current.raw !== raw) throw new ChangedNote();
      const status = articleStatus(current.properties.status);
      if (expectedStatus !== undefined && status !== expectedStatus) throw new ChangedNote();
      if (!status || this.statusFolders[status] === undefined) return;
      this.captures.delete(file);
      await this.relocate(current, status, this.statusFolders[status]!, valid);
    });
  }
  private relocate(
    saved: Snapshot<File>,
    status: string,
    folder: string,
    guard: () => void = () => {},
  ): Promise<Snapshot<File>> {
    return this.creates.run('articles', async () => {
      const name = saved.path.split('/').pop()!;
      const target = await this.unique(folder, name, saved.path);
      if (target === saved.path) return saved;
      await this.validate(saved);
      try {
        await this.vault.move(saved.file, target, (current) => {
          guard();
          this.assert(saved.file, saved.path);
          if (current !== saved.raw) throw new ChangedNote();
        });
      } catch (error) {
        // A native rename may complete before reporting failure. Never roll back
        // YAML or bytes over a concurrent edit; recover the actual catalog path.
        try {
          const actual = await this.read(saved.file.path);
          if (actual.file === saved.file)
            this.catalog.rename(saved.path, actual.path, actual.properties);
        } catch {
          /* A removed/replaced note remains protected. */
        }
        throw new Error(
          `Status saved as ${status}, but the folder move failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const current = await this.read(saved.file.path);
      if (current.file !== saved.file || current.properties.status !== status)
        throw new ChangedNote();
      this.rememberRevision(current.file, current.raw);
      this.catalog.rename(saved.path, current.path, current.properties);
      return current;
    });
  }
  /** Retain first: interruption may leave Later, never an annotated disposable Feed article. */
  annotate(snapshot: Snapshot<File>, transform: (raw: string) => string): Promise<Snapshot<File>> {
    return this.writes.run(snapshot.file, async () => {
      // Validate before moving: invalid selections/cancelled pickers must not cause any mutation.
      const proposed = transform(snapshot.raw);
      if (proposed === snapshot.raw) return snapshot;
      let current = snapshot;
      const promote = queueAt(current.properties) === 'Feed';
      const folder = this.statusFolders.later;
      if (promote) current = await this.moveNow(current, 'Later', () => {}, false);
      if (current.body !== snapshot.body)
        throw new ChangedNote(
          'The article changed to Later, but its text changed. Reopen it to retry the annotation.',
        );
      const annotated = await this.commit(current, (raw) => {
        if (promote && requireArticle(raw).properties.status !== 'later') throw new ChangedNote();
        return transform(raw);
      });
      if (promote && folder !== undefined) return this.relocate(annotated, 'later', folder);
      return annotated;
    });
  }
  /** One serialized local transition; native Sync cannot make two-note writes atomic. */
  dogEar(path: string, guard: () => void = () => {}): Promise<Snapshot<File>> {
    return this.dogEarWrites.run('current', async () => {
      guard();
      const destination = await this.read(path);
      guard();
      if (destination.properties.dog_ear !== undefined && destination.properties.dog_ear !== true)
        throw new Error('Unsupported dog_ear value; preserved the note.');
      // Write the destination first: an unsuccessful write never removes the old pointer.
      const marked = await this.writes.run(destination.file, async () => {
        guard();
        const fresh = await this.read(destination.file.path);
        guard();
        return this.commit(fresh, (raw) => {
          guard();
          return patchProperties(raw, { dog_ear: true });
        });
      });
      for (const article of this.catalog.values()) {
        if (!article.dogEar || article.path === marked.path) continue;
        const file = this.vault.file(article.path);
        if (!file) continue;
        await this.writes.run(file, async () => {
          const previous = await this.read(file.path);
          if (previous.properties.dog_ear === true)
            await this.commit(previous, (raw) => patchProperties(raw, { dog_ear: undefined }));
        });
      }
      return marked;
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
            const folder = saved.path.includes('/')
                ? saved.path.slice(0, saved.path.lastIndexOf('/'))
                : '',
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
              await this.vault.move(saved.file, target, (bytes) => {
                this.assert(saved.file, receipt.path);
                if (this.captures.get(saved.file) !== receipt || bytes !== saved.raw)
                  throw new ChangedNote();
              });
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
  /** Only the explicit confirmed command calls this; no retitle or promotion. */
  replaceArticle(
    snapshot: Snapshot<File>,
    markdown: string,
    title: string,
    guard: () => void,
  ): Promise<Snapshot<File>> {
    return this.writes.run(snapshot.file, () =>
      this.commit(snapshot, (raw) => {
        guard();
        return replaceArticleBody(raw, snapshot.raw, markdown, title);
      }),
    );
  }
  error(snapshot: Snapshot<File>, message?: string): Promise<Snapshot<File>> {
    return this.writes.run(snapshot.file, () =>
      this.commit(snapshot, (raw) => patchProperties(raw, { error: message })),
    );
  }
  trash(snapshot: Snapshot<File>, guard: () => void = () => {}): Promise<void> {
    return this.rss.run('rss', () => this.trashNote(snapshot, guard, true));
  }
  private trashNote(
    snapshot: Snapshot<File>,
    guard: () => void,
    remember = false,
    validate: (current: string) => void = () => {},
  ): Promise<void> {
    this.captures.delete(snapshot.file);
    return this.writes.run(snapshot.file, async () => {
      this.assert(snapshot.file, snapshot.path);
      if ((await this.vault.read(snapshot.file)) !== snapshot.raw) throw new ChangedNote();
      guard();
      if (remember) {
        const subscription = this.associatedSubscription(snapshot.properties.feed, snapshot.path);
        if (subscription) {
          const { file, path } = subscription;
          const url = webUrl(text(snapshot.properties.url));
          this.assert(file, path);
          const before = await this.vault.read(file);
          const raw = await this.vault.process(file, (current) => {
            this.assert(snapshot.file, snapshot.path);
            this.assert(file, path);
            guard();
            if (current !== before) throw new ChangedNote();
            return rememberDeletedUrl(current, url);
          });
          this.catalog.update(path, readDocument(raw).properties);
        }
      }
      await this.vault.trash(snapshot.file, (current) => {
        this.assert(snapshot.file, snapshot.path);
        if (current !== snapshot.raw) throw new ChangedNote();
        validate(current);
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
      if (article.status !== 'feed') continue;
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
        if (!Object.hasOwn(snapshot.properties, 'status') || snapshot.properties.status !== 'feed')
          continue;
        if (hasAnnotations(snapshot.body, snapshot.properties)) {
          await this.move(snapshot, 'Later');
          result.promoted++;
        } else if (
          publicationBefore(snapshot.properties.published, cutoff, filenameDay(snapshot.path))
        ) {
          await this.trashNote(
            snapshot,
            () => {
              if (inUse(file)) throw new ChangedNote('Article is in use.');
            },
            false,
            (raw) => {
              const fresh = requireArticle(raw);
              if (
                !Object.hasOwn(fresh.properties, 'status') ||
                fresh.properties.status !== 'feed' ||
                !publicationBefore(
                  fresh.properties.published,
                  cutoff,
                  filenameDay(snapshot.path),
                ) ||
                hasAnnotations(fresh.body, fresh.properties)
              )
                throw new ChangedNote('Article is no longer eligible for expiry.');
            },
          );
          result.deleted++;
        }
      } catch {
        result.retained++;
      }
    }
    return result;
  }
}
