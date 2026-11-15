import { TFile, type App } from 'obsidian';
import {
  ThinkingStore,
  ThinkingProtection,
  type ThinkingProtectionAuthority,
  type ThinkingReferenceObservation,
  type ThinkingRecord,
  type ThinkingResult,
  type ThinkingTarget,
} from '../core/thinking';
import { readDocument } from '../core/document';
import { excludedReaderPath, linkPath } from '../core/model';
import type { ArticleStore, Snapshot } from '../core/store';
import { ObsidianVault } from './vault';
import { nodesApi } from './nodes';
import type { ThinkingSettings } from './thinking-setup';
import { recordReaderDebug } from './diagnostics';

export interface SourceThinkingMaterial {
  readonly revision: number;
  readonly records: readonly ThinkingRecord[];
  readonly complete: boolean;
  readonly cancelled: boolean;
  readonly documentsRead: number;
  /** Native bytes reserved before dispatch, including failed/uncertain reads. */
  readonly bytesBudgeted: number;
}
const SOURCE_NOTEBOOK_LIMIT = 12;
const SOURCE_BYTE_LIMIT = 200000;

/** Generation-owned native port: no shadow store or startup body scan. */
export class ThinkingRuntime {
  readonly vault: ObsidianVault;
  readonly store: ThinkingStore<TFile>;
  private stopped = false;
  private protection = new ThinkingProtection();
  private known = new Set<TFile>();
  private pendingMetadata = new Set<TFile>();
  private notebookFile?: TFile;
  private sourceRevisions = new WeakMap<TFile, number>();
  private materialRevision = 0;
  private material?: SourceThinkingMaterial;
  private materialWork?: {
    revision: number;
    subscribers: Set<() => boolean>;
    promise: Promise<SourceThinkingMaterial>;
  };
  constructor(
    readonly app: App,
    readonly articles: ArticleStore<TFile>,
    readonly signal: AbortSignal,
    private settings: ThinkingSettings | undefined,
  ) {
    this.vault = new ObsidianVault(app, () => this.guard());
    this.store = new ThinkingStore(this.vault, {
      guard: () => this.assertActive(),
      validateContainer: (kind, path, raw) => this.validateContainer(kind, path, raw),
      observeSource: (source) => {
        const revision = this.sourceRevisions.get(source.file) ?? 0;
        return () => {
          this.assertActive();
          if ((this.sourceRevisions.get(source.file) ?? 0) !== revision)
            throw new Error('Source observation changed. Reopen the article before saving.');
        };
      },
      retainSource: async (source, guard) => {
        guard();
        await articles.validate(source);
        guard();
        return articles.catalog.article(source.path)?.queue === 'Feed'
          ? articles.move(source, 'Later', guard)
          : source;
      },
    });
    this.configure(settings);
  }
  guard(): boolean {
    return !this.stopped && !this.signal.aborted;
  }
  assertActive(): void {
    if (!this.guard()) throw new Error('Reader settings changed. Reopen saved thinking.');
  }
  configure(settings: ThinkingSettings | undefined): void {
    this.settings = settings;
    const path = settings && linkPath(settings.notebook);
    this.notebookFile = path ? this.vault.resolveLink(path, '') : undefined;
    this.invalidate();
  }
  notebookPath(): string {
    this.assertActive();
    if (
      !this.settings ||
      !this.notebookFile ||
      this.vault.file(this.notebookFile.path) !== this.notebookFile
    )
      throw new Error(
        'Configure saved thinking from the reading list or command palette and choose an existing notebook.',
      );
    return this.notebookFile.path;
  }
  private validateContainer(kind: 'notebook' | 'exploration', path: string, raw: string): void {
    this.assertActive();
    const settings = this.settings;
    if (!settings) throw new Error('Configure saved thinking before saving.');
    const type = kind === 'notebook' ? settings.notebookType : settings.explorationType;
    const properties = readDocument(raw).properties;
    const binding = properties[settings.bindingProperty];
    const classes = Array.isArray(binding) ? binding : [binding];
    const api = nodesApi(this.app);
    if (
      !classes.includes(type) ||
      (api &&
        (!api.listTypes().some((candidate) => candidate.type === type) ||
          !api.getNode(path)?.classes.includes(type)))
    )
      throw new Error(
        'The configured container lost its Fileclass type. Configure saved thinking or inspect its Markdown.',
      );
    if (excludedReaderPath(path))
      throw new Error('Templates and trash cannot receive saved thinking.');
  }
  paths(kind: 'notebook' | 'exploration'): string[] {
    const settings = this.settings;
    if (!settings) return [];
    const type = kind === 'notebook' ? settings.notebookType : settings.explorationType;
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => {
        if (excludedReaderPath(file.path)) return false;
        const value =
          this.app.metadataCache.getFileCache(file)?.frontmatter?.[settings.bindingProperty];
        const match = (Array.isArray(value) ? value : [value]).includes(type);
        if (match) this.known.add(file);
        return match;
      })
      .map((file) => file.path);
  }
  /** Native observations revoke negatives synchronously, including type loss and renames. */
  invalidate(file?: TFile, sourceChanged = true): void {
    this.materialRevision++;
    this.material = undefined;
    this.protection.invalidate();
    if (file && !excludedReaderPath(file.path)) {
      this.pendingMetadata.add(file);
      if (sourceChanged) this.sourceRevisions.set(file, (this.sourceRevisions.get(file) ?? 0) + 1);
    }
  }
  metadataSettled(file?: TFile): void {
    this.materialRevision++;
    this.material = undefined;
    this.protection.invalidate();
    if (file) this.pendingMetadata.delete(file);
    else this.pendingMetadata.clear();
  }
  get referenceRevision(): number {
    return this.protection.revision;
  }
  referencePaths(): readonly string[] {
    this.paths('notebook');
    this.paths('exploration');
    return [...this.known]
      .filter((file) => this.vault.file(file.path) === file)
      .map((file) => file.path);
  }
  async keep(
    source: Snapshot<TFile>,
    from: number,
    to: number,
    comment?: string,
    guard?: () => void,
  ): Promise<ThinkingResult<TFile>> {
    return this.capture(() =>
      this.store.keep({ notebookPath: this.notebookPath(), source, from, to, comment, guard }),
    );
  }
  async comment(
    body: string,
    source?: Snapshot<TFile>,
    gap?: number,
    guard?: () => void,
  ): Promise<ThinkingResult<TFile>> {
    return this.capture(() =>
      this.store.comment({ notebookPath: this.notebookPath(), body, source, gap, guard }),
    );
  }
  private async capture(
    work: () => Promise<ThinkingResult<TFile>>,
  ): Promise<ThinkingResult<TFile>> {
    const started = Date.now();
    try {
      const result = await work();
      const durationMs = Math.max(0, Date.now() - started);
      if (result.status === 'saved' || result.status === 'possibly-saved') this.invalidate();
      if (result.status === 'saved' || result.status === 'unchanged')
        recordReaderDebug({
          event: 'operation.completed',
          operation: 'capture',
          durationMs,
          count: result.affectedRecords?.length ?? 0,
        });
      else
        recordReaderDebug({
          event: 'operation.failed',
          operation: 'capture',
          durationMs,
          category:
            result.status === 'possibly-saved'
              ? 'readback'
              : result.phase === 'validation'
                ? 'validation'
                : 'write',
        });
      return result;
    } catch (error) {
      const durationMs = Math.max(0, Date.now() - started);
      if (this.guard())
        recordReaderDebug({
          event: 'operation.failed',
          operation: 'capture',
          durationMs,
          category: 'unknown',
        });
      else recordReaderDebug({ event: 'operation.cancelled', operation: 'capture', durationMs });
      throw error;
    }
  }
  get sourceMaterialRevision(): number {
    return this.materialRevision;
  }
  /** Automatic article decoration has a total I/O/parse budget, independent of library size.
   * Reuse read-only same-revision observations, including truthful partial coverage. */
  readSourceMaterial(current: () => boolean): Promise<SourceThinkingMaterial> {
    const revision = this.materialRevision;
    if (this.material?.revision === revision) return Promise.resolve(this.material);
    let work = this.materialWork;
    if (!work || work.revision !== revision) {
      const subscribers = new Set<() => boolean>([current]);
      const active = () =>
        this.guard() &&
        revision === this.materialRevision &&
        [...subscribers].some((valid) => valid());
      const promise = this.scanSourceMaterial(revision, active).then((material) => {
        if (!material.cancelled && this.guard() && revision === this.materialRevision)
          this.material = material;
        return material;
      });
      work = { revision, subscribers, promise };
      this.materialWork = work;
      const settled = () => {
        if (this.materialWork?.promise === promise) this.materialWork = undefined;
      };
      void promise.then(settled, settled);
    } else work.subscribers.add(current);
    const subscribed = work;
    return work.promise.finally(() => subscribed.subscribers.delete(current));
  }
  private async scanSourceMaterial(
    revision: number,
    active: () => boolean,
  ): Promise<SourceThinkingMaterial> {
    const records: ThinkingRecord[] = [];
    if (!active())
      return {
        revision,
        records,
        complete: false,
        cancelled: true,
        documentsRead: 0,
        bytesBudgeted: 0,
      };
    let complete = true,
      documentsRead = 0,
      bytesBudgeted = 0;
    const paths = this.paths('notebook');
    const preferred = this.notebookFile?.path;
    if (preferred && this.vault.file(preferred) === this.notebookFile) {
      const at = paths.indexOf(preferred);
      if (at >= 0) paths.splice(at, 1);
      paths.unshift(preferred);
    }
    if (paths.length > SOURCE_NOTEBOOK_LIMIT) complete = false;
    for (const path of paths.slice(0, SOURCE_NOTEBOOK_LIMIT)) {
      if (!active()) break;
      const file = this.vault.file(path),
        size = file?.stat?.size;
      const remaining = SOURCE_BYTE_LIMIT - bytesBudgeted;
      if (
        !file ||
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > remaining
      ) {
        complete = false;
        continue;
      }
      const guard = () => {
        if (
          !active() ||
          this.vault.file(path) !== file ||
          file.path !== path ||
          file.stat.size !== size
        )
          throw new Error('Source-material observation changed.');
      };
      try {
        // Core retains its occupied native slot through settlement. Both preflight
        // and the post-read guard run before its parser sees this document.
        documentsRead++;
        bytesBudgeted += size;
        const document = await this.store.read(path, guard);
        const bytes = new TextEncoder().encode(document.raw).byteLength;
        if (bytes !== size) {
          bytesBudgeted += Math.max(0, bytes - size);
          complete = false;
          if (bytesBudgeted >= SOURCE_BYTE_LIMIT) break;
          continue;
        }
        records.push(...document.records);
        if (document.issues.length) complete = false;
      } catch {
        complete = false;
      }
    }
    return {
      revision,
      records,
      complete: complete && active(),
      cancelled: !active(),
      documentsRead,
      bytesBudgeted,
    };
  }
  resolveSource(record: ThinkingRecord): TFile | undefined {
    return record.source ? this.vault.resolveLink(record.source.path, record.path) : undefined;
  }
  target(record: ThinkingRecord): ThinkingTarget {
    return { path: record.path, blockId: record.blockId };
  }
  /** Fresh, bounded per-file reads on an explicit protection request, never startup scans. */
  async referenceAuthority(sourcePath: string): Promise<ThinkingProtectionAuthority> {
    const previous = this.protection.authority(sourcePath);
    if (!this.guard() || previous.coverage === 'complete') return previous;
    const revision = this.protection.revision;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => !excludedReaderPath(file.path));
    const observations: ThinkingReferenceObservation[] = [];
    const documents: {
      file: TFile;
      document: Awaited<ReturnType<ThinkingStore<TFile>['read']>>;
      observation: ThinkingReferenceObservation;
    }[] = [];
    for (const file of files) {
      if (!this.guard() || this.protection.revision !== revision)
        return this.protection.authority(sourcePath);
      const cache = this.app.metadataCache.getFileCache(file);
      const observation = {
        path: file.path,
        sourcePaths: [] as string[],
        complete: !!cache && !this.pendingMetadata.has(file),
      };
      observations.push(observation);
      // Native cached links supplement owned Source/About/membership references.
      for (const link of [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])]) {
        const path = link.link.split('#')[0];
        if (!path || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(path)) continue;
        const target = this.vault.resolveLink(path, file.path);
        if (target && this.articles.catalog.article(target.path))
          observation.sourcePaths.push(target.path);
      }
      const settings = this.settings;
      const binding = settings && cache?.frontmatter?.[settings.bindingProperty];
      const classes = Array.isArray(binding) ? binding : [binding];
      const relevant =
        !!settings &&
        (classes.includes(settings.notebookType) || classes.includes(settings.explorationType));
      if (!relevant && !this.known.has(file) && cache && !this.pendingMetadata.has(file)) continue;
      if (file.stat?.size > 200000) {
        observation.complete = false;
        continue;
      }
      try {
        const document = await this.store.read(file.path);
        if (document.raw.length > 200000) {
          observation.complete = false;
          continue;
        }
        let freshClasses: unknown[] = [];
        try {
          const properties = readDocument(document.raw).properties;
          const value = settings && properties[settings.bindingProperty];
          freshClasses = Array.isArray(value) ? value : [value];
        } catch {
          /* Untyped ordinary Markdown cannot be an eligible container. */
        }
        const freshRelevant =
          !!settings &&
          (freshClasses.includes(settings.notebookType) ||
            freshClasses.includes(settings.explorationType));
        if (freshRelevant) this.known.add(file);
        if (this.known.has(file) && !freshRelevant) observation.complete = false;
        if (freshRelevant || this.known.has(file)) {
          if (document.issues.length || document.records.some((record) => record.readOnly))
            observation.complete = false;
          documents.push({ file, document, observation });
        }
      } catch {
        observation.complete = false;
      }
    }
    for (const { file, document, observation } of documents) {
      const targets = [
        ...document.records.flatMap((record) => [
          record.source,
          record.about,
          ...record.connections.map((connection) => connection.target),
        ]),
        ...document.memberships.map((membership) => membership.target),
      ];
      for (const target of targets) {
        if (!target) continue;
        const resolved = this.vault.resolveLink(target.path, file.path);
        if (!resolved) {
          observation.complete = false;
          continue;
        }
        if (this.articles.catalog.article(resolved.path))
          observation.sourcePaths = [...observation.sourcePaths, resolved.path];
        if (target.blockId && !this.articles.catalog.article(resolved.path)) {
          const container = documents.find((entry) => entry.file === resolved);
          if (
            !container ||
            container.document.records.filter(
              (record) => record.blockId === target.blockId && !record.readOnly,
            ).length !== 1
          )
            observation.complete = false;
        }
      }
    }
    if (this.guard())
      this.protection.publish(
        revision,
        observations,
        files.map((file) => file.path),
      );
    return this.protection.authority(sourcePath);
  }
  dispose(): void {
    this.stopped = true;
    this.materialRevision++;
    this.material = undefined;
    this.protection.invalidate();
    this.store.dispose();
  }
  async drain(): Promise<void> {
    await this.store.drain();
    await this.vault.drain();
  }
}

export function thinkingSaveMessage(
  result: Pick<ThinkingResult<TFile>, 'status' | 'phase' | 'message'>,
): string {
  if (result.status === 'saved') return 'Saved locally. Obsidian handles Sync.';
  if (result.status === 'unchanged') return 'Already saved.';
  if (result.status === 'possibly-saved')
    return `Possibly saved — open notebook to check (${result.phase}). Do not repeat this save blindly.`;
  if (result.status === 'partial')
    return `Source retained; ${result.phase} incomplete. ${result.message ?? 'Open notebook to check before retrying.'}`;
  return (
    result.message ?? 'Not saved. Configure saved thinking or inspect the notebook, then retry.'
  );
}
