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
  replaceBody,
  savePosition,
} from './document';
import { hasAnnotations } from './annotations';
import {
  deletedUrls,
  linkPath,
  text,
  filename,
  filenameDay,
  formatPublished,
  monthCutoff,
  publicationBefore,
  excludedReaderPath,
  queueStatus,
  timestamp,
  vaultLink,
  webUrl,
  type Properties,
  type Queue,
} from './model';
import { SerialWrites } from './work';
import {
  appendQuotation,
  localCollectionDate,
  originLink,
  rememberOrigin,
  removeQuotation,
} from './quotation';
import { defaultFolders, type ReaderFolders } from './folders';
import {
  defaultStatusFolders,
  queueForPath,
  validateStatusFolders,
  type StatusFolders,
  type ResolvedStatusFolders,
} from './status-folders';

function protectedArticle(body: string, properties: Properties): boolean {
  const topics = properties.topics;
  return (
    hasAnnotations(body, properties) ||
    (topics !== undefined &&
      topics !== null &&
      topics !== '' &&
      (!Array.isArray(topics) || topics.length > 0))
  );
}

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
export interface HighlightCollectionEdit {
  /** Source body produced by the source-mapped hosting/conversion operation. */
  body: string;
  quoteMarkdown: string;
  blockId: string;
}
export type HighlightCollectionPhase = 'source' | 'destination';
export interface HighlightCollectionOptions {
  created?: boolean;
  remember?: boolean;
  mode?: 'highlight' | 'mention';
  /** Testable collection clock, frozen at invocation; persisted only as a quotation date link. */
  collectedOn?: Date;
  /** Required at runtime: recheck provider, membership, source and lifetime in both
   * phases. Live native Selection is authoritative only until annotation is saved. */
  guard?: (phase: HighlightCollectionPhase) => void;
}
export interface HighlightCollectionManyOptions extends Omit<
  HighlightCollectionOptions,
  'created' | 'mode'
> {
  /** Only notes newly created for this operation may receive a missing origin. */
  createdPaths?: readonly string[];
  /** Explicitly unchecked hosts of this particular passage, not article topics. */
  removedDestinationPaths?: readonly string[];
  /** Exact previous passage/citation authority, required for explicit removals. */
  previousQuote?: Pick<HighlightCollectionEdit, 'quoteMarkdown' | 'blockId'>;
  mode?: 'highlight';
}
/** Source retention or annotation succeeded, but collection did not finish. Never roll it back. */
export class PartialCollectionError<File extends NoteFile> extends Error {
  readonly completedDestinationPaths: readonly string[];
  readonly completedRemovalPaths: readonly string[];
  get savedSnapshot(): Snapshot<File> {
    return this.snapshot;
  }
  constructor(
    readonly snapshot: Snapshot<File>,
    readonly destinationPath: string,
    cause: unknown,
    mode: 'highlight' | 'mention' = 'highlight',
    readonly annotationSaved = true,
    completedDestinationPaths: readonly string[] = [],
    completedRemovalPaths: readonly string[] = [],
    readonly destinationOperation: 'collect' | 'remove' = 'collect',
  ) {
    super(
      `${annotationSaved ? 'The source annotation was saved, but' : 'The source was retained; its annotation was not saved and'} ${destinationOperation === 'remove' ? 'the stored quotation was not removed' : mode === 'mention' ? 'the destination update was not saved' : 'the quotation was not filed'} in ${destinationPath}. Reopen the source and retry: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'PartialCollectionError';
    this.completedDestinationPaths = Object.freeze([...completedDestinationPaths]);
    this.completedRemovalPaths = Object.freeze([...completedRemovalPaths]);
  }
}

/** The only route to article mutations: one per-file queue, fresh bytes, then guarded commit. */
export class ArticleStore<File extends NoteFile> {
  readonly catalog: Catalog;
  private writes = new SerialWrites<File>();
  // Enter before any file lane; never hold one file lane while acquiring another.
  private collections = new SerialWrites<string>();
  private dogEarWrites = new SerialWrites<string>();
  private creates = new SerialWrites<string>();
  // Imports and explicit trash share a lane through the final native operation.
  private rss = new SerialWrites<string>();
  // Filename ownership is session-local, never inferred from a hostname/date on disk.
  // After restart an unfinished capture keeps its original filename, even on success.
  private captures = new WeakMap<File, { path: string; date: Date }>();
  private active = true;
  readonly folders: ReaderFolders;
  private statusFolders: ResolvedStatusFolders = defaultStatusFolders;
  private statusFolderRevision = 0;
  get statusFolderGeneration(): number {
    return this.statusFolderRevision;
  }
  setStatusFolders(folders: StatusFolders): void {
    this.statusFolders = validateStatusFolders(folders);
    this.catalog.setStatusFolders(this.statusFolders);
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
    if (excludedReaderPath(expectedPath) || excludedReaderPath(file.path))
      throw new ChangedNote('Templates and trash are not Reader articles.');
    this.captureReceipt(file); // Observed native/user renames permanently revoke the receipt.
    if (file.path !== expectedPath || this.vault.file(expectedPath) !== file)
      throw new ChangedNote();
    this.vault.assertWritable(file);
  }
  async read(path: string): Promise<Snapshot<File>> {
    if (!this.active) throw new Error('Reader has stopped.');
    if (excludedReaderPath(path))
      throw new ChangedNote('Templates and trash are not Reader articles.');
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
  /** Freeze settings authority at request time, before entering any serialization lane. */
  private folderGuard<Args extends unknown[]>(
    guard: (...args: Args) => void,
  ): (...args: Args) => void {
    const generation = this.statusFolderRevision;
    return (...args) => {
      guard(...args);
      if (generation !== this.statusFolderRevision)
        throw new ChangedNote('Reader queue folders changed. Reopen the article and retry.');
    };
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
      if (excludedReaderPath(path)) return false;
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
      return next;
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
    const check = this.folderGuard(guard);
    return this.writes.run(snapshot.file, () => this.moveNow(snapshot, queue, check));
  }
  private async moveNow(
    snapshot: Snapshot<File>,
    queue: Queue,
    guard: () => void = () => {},
    relocate = true,
    onSaved?: (saved: Snapshot<File>) => void,
  ): Promise<Snapshot<File>> {
    guard();
    this.captures.delete(snapshot.file);
    const status = queueStatus(queue),
      folder = this.statusFolders[status],
      transition = queueForPath(snapshot.path, this.statusFolders) !== queue;
    const saved = await this.commit(snapshot, (raw) => {
      guard();
      return patchProperties(raw, { status });
    });
    onSaved?.(saved);
    try {
      guard();
    } catch (error) {
      throw new Error(
        `Status saved as ${status}, but the operation stopped: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    // YAML commits first: a failed relocation never makes a retained article disposable.
    // The destination folder, not stale YAML, determines whether a move is needed.
    if (!relocate || !transition) return saved;
    return this.relocate(saved, status, folder, guard);
  }
  private relocate(
    saved: Snapshot<File>,
    status: string,
    folder: string,
    guard: () => void = () => {},
  ): Promise<Snapshot<File>> {
    return this.creates.run('articles', async () => {
      try {
        guard();
        const name = saved.path.split('/').pop()!;
        const target = await this.unique(folder, name, saved.path);
        guard();
        await this.validate(saved);
        guard();
        if (target === saved.path) return saved;
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
      this.catalog.rename(saved.path, current.path, current.properties);
      return current;
    });
  }
  /** Retain first: interruption may leave Later, never an annotated disposable Feed article. */
  annotate(snapshot: Snapshot<File>, transform: (raw: string) => string): Promise<Snapshot<File>> {
    const guard = this.folderGuard(() => {});
    return this.writes.run(snapshot.file, () => this.annotateNow(snapshot, transform, guard));
  }
  private async annotateNow(
    snapshot: Snapshot<File>,
    transform: (raw: string) => string,
    guard: () => void = () => {},
    onSaved?: (saved: Snapshot<File>) => void,
    onRetained?: (saved: Snapshot<File>) => void,
  ): Promise<Snapshot<File>> {
    // Validate before moving: invalid selections/cancelled pickers must not cause any mutation.
    guard();
    const proposed = transform(snapshot.raw);
    if (proposed === snapshot.raw && !onSaved) {
      await this.validate(snapshot);
      guard();
      return snapshot;
    }
    let current = snapshot;
    const promote = queueForPath(current.path, this.statusFolders) === 'Feed';
    const folder = this.statusFolders.later;
    if (promote) {
      current = await this.moveNow(current, 'Later', guard, false, onRetained);
    }
    if (current.body !== snapshot.body)
      throw new ChangedNote(
        'The article changed to Later, but its text changed. Reopen it to retry the annotation.',
      );
    const annotated = await this.commit(current, (raw) => {
      guard();
      if (promote && requireArticle(raw).properties.status !== 'later') throw new ChangedNote();
      return transform(raw);
    });
    onSaved?.(annotated);
    guard();
    if (promote) return this.relocate(annotated, 'later', folder, guard);
    return annotated;
  }
  /** Replace only baseline typed relationships; never edit filed snapshots. The guard
   * must recheck public membership for selected nodes and unchecked typed originals. */
  async setRelatedNodes(
    snapshot: Snapshot<File>,
    selectedPaths: readonly string[],
    replaceablePaths: readonly string[],
    guard?: () => void,
  ): Promise<Snapshot<File>> {
    snapshot = { ...snapshot, properties: { ...snapshot.properties } };
    const selected = [...new Set(selectedPaths)].map((path) => ({
      path,
      file: this.vault.file(path),
    }));
    const baseline = new Map(
      [...new Set(replaceablePaths)].map((path) => [path, this.vault.file(path)]),
    );
    if (typeof guard !== 'function')
      throw new Error(
        'A current typed-destination eligibility guard is required to set related nodes.',
      );
    guard = this.folderGuard(guard);
    guard();
    const doc = requireArticle(snapshot.raw);
    const previous = Object.hasOwn(doc.properties, 'topics')
      ? Array.isArray(doc.properties.topics)
        ? doc.properties.topics
        : [doc.properties.topics]
      : [];
    const resolve = (link: string) =>
      this.vault.resolveLink
        ? this.vault.resolveLink(link, snapshot.path)
        : (this.vault.file(link) ?? this.vault.file(link + '.md'));
    const originals = previous.map((value) => {
      const link = linkPath(text(value));
      const file = link ? resolve(link) : undefined;
      return {
        value,
        link,
        file,
        path: file?.path,
        replaceable: !!file && !excludedReaderPath(file.path) && baseline.get(file.path) === file,
      };
    });
    return this.writes.run(snapshot.file, async () => {
      const check = () => {
        guard();
        for (const target of selected) {
          vaultLink(target.path);
          if (
            !target.file ||
            excludedReaderPath(target.path) ||
            target.file.path !== target.path ||
            this.vault.file(target.path) !== target.file
          )
            throw new ChangedNote('A related typed destination changed. Reopen the picker.');
        }
      };
      check();
      const retained = originals.filter(
        (original) =>
          !original.replaceable || selected.some((target) => target.file === original.file),
      );
      const values = [
        ...retained.map((original) => original.value),
        ...selected
          .filter((target) => !retained.some((original) => original.file === target.file))
          .map((target) => vaultLink(target.path)),
      ];
      const unchanged =
        values.length === previous.length &&
        values.every((value, index) => value === previous[index]);
      const validate = () => {
        check();
        for (const original of originals) {
          if (
            original.file &&
            (original.replaceable || selected.some((target) => target.file === original.file)) &&
            (original.file.path !== original.path || resolve(original.link!) !== original.file)
          )
            throw new ChangedNote(
              'An existing related-node link changed meaning. Reopen the picker.',
            );
        }
      };
      const transform = (raw: string) => {
        validate();
        if (requireArticle(raw).body !== snapshot.body) throw new ChangedNote();
        return unchanged
          ? raw
          : patchProperties(raw, { topics: values.length ? values : undefined });
      };
      await this.validate(snapshot);
      this.vault.assertWritable(snapshot.file, snapshot.raw);
      // A no-op must still validate exact source bytes, without promoting a Feed article.
      if (unchanged) {
        const saved = await this.commit(snapshot, transform);
        validate();
        return saved;
      }
      return this.annotateNow(snapshot, transform, validate);
    });
  }
  /** Backward-compatible single destination, including explicit node-only conversion. */
  collectHighlight(
    snapshot: Snapshot<File>,
    edit: HighlightCollectionEdit,
    destinationPath: string,
    options: HighlightCollectionOptions = {},
  ): Promise<Snapshot<File>> {
    const { created = false, ...rest } = options;
    return this.collectHighlightSet(snapshot, edit, [destinationPath], {
      ...rest,
      createdPaths: created ? [destinationPath] : [],
    });
  }
  /** One source annotation, then sequential guarded destination writes; never a cross-file transaction. */
  collectHighlightMany(
    snapshot: Snapshot<File>,
    edit: HighlightCollectionEdit,
    destinationPaths: readonly string[],
    options: HighlightCollectionManyOptions = {},
  ): Promise<Snapshot<File>> {
    if (options.mode !== undefined && options.mode !== 'highlight')
      return Promise.reject(new Error('Multi-destination collection only supports highlights.'));
    return this.collectHighlightSet(snapshot, edit, destinationPaths, options);
  }
  private collectHighlightSet(
    snapshot: Snapshot<File>,
    edit: HighlightCollectionEdit,
    destinationPaths: readonly string[],
    options: Omit<HighlightCollectionManyOptions, 'mode'> &
      Pick<HighlightCollectionOptions, 'mode'>,
  ): Promise<Snapshot<File>> {
    // Freeze caller-owned inputs before serialization, including provider/lifetime authority.
    snapshot = { ...snapshot, properties: { ...snapshot.properties } };
    const { body, quoteMarkdown, blockId } = edit;
    const { remember = true, mode = 'highlight' } = options;
    const guard = typeof options.guard === 'function' ? this.folderGuard(options.guard) : undefined;
    const paths = [...new Set(destinationPaths)];
    const removedPaths = [...new Set(options.removedDestinationPaths ?? [])];
    const created = new Set(options.createdPaths ?? []);
    const previousQuote = options.previousQuote ? { ...options.previousQuote } : undefined;
    const collectedOn = new Date(options.collectedOn?.getTime() ?? Date.now());
    const destinationFiles = new Map(
      [...paths, ...removedPaths].map((path) => [path, this.vault.file(path)]),
    );
    return this.collections.run('collection', async () => {
      if (typeof guard !== 'function')
        throw new Error(
          'A current typed-destination eligibility guard is required to collect a highlight.',
        );
      if (mode !== 'highlight' && mode !== 'mention') throw new Error('Invalid collection mode.');
      if (!paths.length && !removedPaths.length)
        throw new Error('A new highlight needs at least one typed destination.');
      if (removedPaths.length && (!previousQuote || mode !== 'highlight'))
        throw new Error(
          'Explicit quotation removal requires the previous highlight passage and paragraph citation.',
        );
      if (removedPaths.some((path) => paths.includes(path)))
        throw new Error('A destination cannot be both selected and removed.');
      if ([...created].some((path) => !paths.includes(path)))
        throw new Error('A newly created destination must be selected.');
      guard('source');
      const collectedDate = localCollectionDate(collectedOn);
      const destinations = [
        ...paths.map((path) => ({ path, operation: 'collect' as const })),
        ...removedPaths.map((path) => ({ path, operation: 'remove' as const })),
      ].map(({ path, operation }) => {
        const file = destinationFiles.get(path);
        if (!file) throw new ChangedNote('The destination note no longer exists.');
        if (file === snapshot.file || path === snapshot.path)
          throw new Error('The source and destination must not be the same note.');
        return {
          path,
          operation,
          file,
          link: vaultLink(path.replace(/\.md$/iu, '')),
          raw: undefined as string | undefined,
        };
      });
      let saved: Snapshot<File> | undefined;
      let annotationSaved = false;
      let failed = destinations[0];
      const completed: string[] = [],
        completedRemovals: string[] = [];
      const assertDestination = (destination: (typeof destinations)[number]) => {
        guard(annotationSaved ? 'destination' : 'source');
        this.assert(destination.file, destination.path);
        this.vault.assertWritable(destination.file, destination.raw);
      };
      const assertDestinations = () => {
        for (const destination of destinations) {
          try {
            assertDestination(destination);
          } catch (error) {
            failed = destination;
            throw error;
          }
        }
      };
      const updateDestination = (
        destination: (typeof destinations)[number],
        raw: string,
        source: Snapshot<File>,
      ): string => {
        const title =
          text(source.properties.title) || source.path.split('/').pop()!.replace(/\.md$/iu, '');
        if (destination.operation === 'remove') {
          return removeQuotation(
            raw,
            previousQuote!.quoteMarkdown,
            originLink(source.path, previousQuote!.blockId, title),
          ).raw;
        }
        const origin = originLink(source.path, blockId);
        let next =
          mode === 'highlight'
            ? appendQuotation(raw, quoteMarkdown, originLink(source.path, blockId, title), {
                path: source.path,
                title,
                collectedOn: collectedDate,
              }).raw
            : raw;
        if (created.has(destination.path)) next = rememberOrigin(next, origin);
        return next;
      };
      try {
        const annotated = await this.writes.run(snapshot.file, async () => {
          await this.validate(snapshot);
          this.vault.assertWritable(snapshot.file, snapshot.raw);
          // Every selected/removed target must be provably safe before even retaining Feed.
          for (const destination of destinations) {
            failed = destination;
            assertDestination(destination);
            destination.raw = await this.vault.read(destination.file);
            assertDestination(destination);
            readDocument(destination.raw);
            updateDestination(destination, destination.raw, snapshot);
          }
          failed = destinations[0];
          const transform = (raw: string): string => {
            assertDestinations();
            const doc = requireArticle(raw);
            let next = replaceBody(raw, snapshot.body, body);
            if (!remember) return next;
            const previous = Object.hasOwn(doc.properties, 'topics')
              ? Array.isArray(doc.properties.topics)
                ? doc.properties.topics
                : [doc.properties.topics]
              : [];
            const additions = destinations
              .filter(
                (destination) =>
                  destination.operation === 'collect' &&
                  !previous.some((value) => {
                    const path = linkPath(text(value));
                    return (
                      path !== undefined &&
                      (path.replace(/\.md$/iu, '') === destination.path.replace(/\.md$/iu, '') ||
                        this.vault.resolveLink?.(path, snapshot.path) === destination.file)
                    );
                  }),
              )
              .map((destination) => destination.link);
            if (additions.length)
              next = patchProperties(next, { topics: [...previous, ...additions] });
            return next;
          };
          return this.annotateNow(
            snapshot,
            transform,
            assertDestinations,
            (source) => {
              saved = source;
              annotationSaved = true;
            },
            (source) => {
              saved = source;
            },
          );
        });
        saved = annotated;
        // Never hold the source lane while acquiring a destination lane (or two destinations).
        for (const destination of destinations) {
          failed = destination;
          guard('destination');
          await this.writes.run(destination.file, async () => {
            await this.validate(annotated);
            this.vault.assertWritable(annotated.file, annotated.raw);
            // Native source relocation may have rewritten any target's links. Reread each.
            destination.raw = undefined;
            assertDestination(destination);
            destination.raw = await this.vault.read(destination.file);
            assertDestination(destination);
            const expected = destination.raw;
            await this.validate(annotated);
            const update = (current: string) => {
              assertDestination(destination);
              this.assert(annotated.file, annotated.path);
              this.vault.assertWritable(annotated.file, annotated.raw);
              if (current !== expected) throw new ChangedNote();
              return updateDestination(destination, current, annotated);
            };
            if (update(expected) === expected) update(await this.vault.read(destination.file));
            else await this.vault.process(destination.file, update);
          });
          (destination.operation === 'remove' ? completedRemovals : completed).push(
            destination.path,
          );
          // Completed writes remain successful. Recheck before dispatching the next target,
          // not after the final native write has already completed.
        }
        return annotated;
      } catch (error) {
        if (!saved) throw error;
        // A dispatched native rename can rewrite links before rejecting. Reconcile actual
        // path and bytes, without allowing a replaced/removed note to hide known progress.
        try {
          const actual = await this.read(saved.file.path);
          if (actual.file === saved.file) saved = actual;
        } catch {
          if (this.vault.file(saved.file.path) === saved.file)
            saved = { ...saved, path: saved.file.path };
        }
        throw new PartialCollectionError(
          saved,
          failed.path,
          error,
          mode,
          annotationSaved,
          completed,
          completedRemovals,
          failed.operation,
        );
      }
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
    // Explicit Delete also retains annotated/topic-bearing articles. A stale snapshot
    // cannot bypass this: move revalidates the exact bytes before writing or renaming.
    if (protectedArticle(snapshot.body, snapshot.properties))
      return this.move(snapshot, 'Archive', guard).then(() => {});
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
        if (remember) {
          const fresh = requireArticle(current);
          if (protectedArticle(fresh.body, fresh.properties))
            throw new ChangedNote('Protected articles can only be archived.');
        }
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
    const guard = this.folderGuard(() => {});
    const result = { deleted: 0, retained: 0, promoted: 0 },
      cutoff = monthCutoff(now);
    for (const article of [...this.catalog.values()]) {
      if (!this.active) break;
      if (article.queue !== 'Feed' || article.status !== 'feed') continue;
      // Cleanup needs bodies only for potentially expired notes. Fresh/undated
      // annotation promotion belongs to native change handling and reader writes.
      if (!publicationBefore(article.published, cutoff, filenameDay(article.path))) continue;
      const file = this.vault.file(article.path);
      if (!file || this.busy(file) || inUse(file)) {
        result.retained++;
        continue;
      }
      try {
        guard();
        const snapshot = await this.read(article.path);
        guard();
        if (
          queueForPath(snapshot.path, this.statusFolders) !== 'Feed' ||
          snapshot.properties.status !== 'feed'
        )
          continue;
        if (protectedArticle(snapshot.body, snapshot.properties)) {
          await this.move(snapshot, 'Archive', guard);
          result.promoted++;
        } else if (
          publicationBefore(snapshot.properties.published, cutoff, filenameDay(snapshot.path))
        ) {
          await this.trashNote(
            snapshot,
            () => {
              guard();
              if (inUse(file)) throw new ChangedNote('Article is in use.');
            },
            false,
            (raw) => {
              const fresh = requireArticle(raw);
              if (
                !Object.hasOwn(fresh.properties, 'status') ||
                fresh.properties.status !== 'feed' ||
                queueForPath(snapshot.file.path, this.statusFolders) !== 'Feed' ||
                !publicationBefore(
                  fresh.properties.published,
                  cutoff,
                  filenameDay(snapshot.path),
                ) ||
                protectedArticle(fresh.body, fresh.properties)
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
