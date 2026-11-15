import { ChangedNote, readDocument, requireArticle } from './document';
import { bounded } from '../content/bounds';
import { excludedReaderPath } from './model';
import type { NoteFile, Snapshot, VaultPort } from './store';
import { SerialWrites, WorkQueue } from './work';
import { localCollectionDate } from './quotation';
import {
  anchorCounts,
  connectionLine,
  parseThinking,
  quoteLines,
  renderRecord,
  targetLink,
} from './thinking/records';
import { existingSourceAnchor, lookupContext, selectedSource, sourceGap } from './thinking/source';
import type {
  ThinkingComment,
  ThinkingConnection,
  ThinkingDocument,
  ThinkingExplorationEdit,
  ThinkingKeep,
  ThinkingOptions,
  ThinkingRecord,
  ThinkingResult,
  ThinkingSearchOptions,
  ThinkingSearchResult,
  ThinkingTarget,
} from './thinking/types';
export * from './thinking/types';
export { sourceProjection } from './thinking/source';
export {
  projectThinking,
  type ThinkingReadProjection,
  type ThinkingProjectedEntry,
} from './thinking/projection';
export {
  ThinkingProtection,
  type ThinkingProtectionAuthority,
  type ThinkingReferenceObservation,
} from './thinking/protection';

/** Ordinary Markdown body edits only. Provider-owned creation/fields remain in the host. */
export class ThinkingStore<File extends NoteFile> {
  private active = true;
  private writes = new SerialWrites<File>();
  private reads = new WorkQueue(3);
  private readSequence = 0;
  private actions = new SerialWrites<string>();
  private pending = new Set<Promise<unknown>>();
  private inFlight = new Map<string, Promise<ThinkingResult<File>>>();
  constructor(
    readonly vault: VaultPort<File>,
    private readonly options: ThinkingOptions<File> = {},
  ) {}
  dispose(): void {
    this.active = false;
    this.reads.stop();
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  private guard(extra?: () => void): void {
    if (!this.active) throw new Error('Reader Thinking has stopped.');
    this.options.guard?.();
    extra?.();
  }
  private identity(file: File, path: string): void {
    if (excludedReaderPath(path) || file.path !== path || this.vault.file(path) !== file)
      throw new ChangedNote();
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const done = () => this.pending.delete(promise);
    void promise.then(done, done);
    return promise;
  }
  async read(path: string, guard?: () => void): Promise<ThinkingDocument<File>> {
    this.guard(guard);
    const file = this.vault.file(path);
    if (!file) throw new Error('The notebook no longer exists. Configure an existing notebook.');
    this.identity(file, path);
    let raw = '';
    await this.track(
      this.reads.enqueue(
        String(++this.readSequence),
        async () => {
          this.guard(guard);
          this.identity(file, path);
          raw = await this.vault.read(file);
        },
        true,
      ),
    );
    bounded(raw);
    this.guard(guard);
    this.identity(file, path);
    return parseThinking(file, raw);
  }
  private async validateSource(source: Snapshot<File>, extra?: () => void): Promise<void> {
    this.guard(extra);
    this.identity(source.file, source.path);
    this.vault.assertWritable(source.file, source.raw);
    const raw = await this.vault.read(source.file);
    this.guard(extra);
    this.identity(source.file, source.path);
    this.vault.assertWritable(source.file, raw);
    if (raw !== source.raw || requireArticle(raw).body !== source.body)
      throw new ChangedNote('Source text changed. Reopen the article before saving.');
  }
  private async retain(source: Snapshot<File>, extra?: () => void): Promise<Snapshot<File>> {
    await this.validateSource(source, extra);
    if (!this.options.retainSource)
      throw new Error('Source retention is unavailable. Reopen Reader before saving.');
    // No target file lane is held while ArticleStore owns the source lane.
    const retained = await this.options.retainSource(source, () => this.guard(extra));
    if (retained.file !== source.file || retained.body !== source.body)
      throw new ChangedNote('The retained source changed.');
    await this.validateSource(retained, extra);
    return retained;
  }
  private failure(error: unknown, retainedSource?: Snapshot<File>): ThinkingResult<File> {
    return {
      status: retainedSource ? 'partial' : 'failed',
      phase: retainedSource ? 'notebook' : 'validation',
      records: [],
      originalRecords: [],
      retainedSource,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  private async commit(
    document: ThinkingDocument<File>,
    next: string,
    phase: 'notebook' | 'exploration',
    extra?: () => void,
    source?: Snapshot<File>,
    originals: ThinkingRecord[] = [],
  ): Promise<ThinkingResult<File>> {
    return this.writes.run(document.file, async () => {
      let dispatched = false;
      let affected: ThinkingRecord[] = [];
      try {
        this.guard(extra);
        this.identity(document.file, document.path);
        this.vault.assertWritable(document.file, document.raw);
        if (source) await this.validateSource(source, extra);
        const current = await this.vault.read(document.file);
        this.guard(extra);
        this.identity(document.file, document.path);
        this.vault.assertWritable(document.file, current);
        if (current !== document.raw) throw new ChangedNote();
        if (next === current)
          return {
            status: 'unchanged',
            phase,
            records: document.records,
            originalRecords: originals,
            document,
            retainedSource: source,
          };
        // Validate proposed shape before dispatch; never publish malformed generated entries.
        this.options.validateContainer?.(
          phase === 'exploration' ? 'exploration' : 'notebook',
          document.path,
          current,
        );
        bounded(next);
        const proposed = parseThinking(document.file, next);
        affected = proposed.records.filter(
          (record) =>
            !document.records.some(
              (previous) => previous.blockId === record.blockId && previous.raw === record.raw,
            ),
        );
        if (proposed.issues.length > document.issues.length)
          throw new Error('The proposed Markdown is not an unambiguous native Thinking record.');
        await this.vault.process(document.file, (raw) => {
          this.guard(extra);
          this.identity(document.file, document.path);
          this.vault.assertWritable(document.file, raw);
          if (source) {
            this.identity(source.file, source.path);
            this.vault.assertWritable(source.file, source.raw);
          }
          if (raw !== document.raw) throw new ChangedNote();
          this.options.validateContainer?.(
            phase === 'exploration' ? 'exploration' : 'notebook',
            document.path,
            raw,
          );
          dispatched = true;
          return next;
        });
        // Keep the native slot occupied through settlement and independent readback.
        const readback = await this.vault.read(document.file);
        this.identity(document.file, document.path);
        if (readback !== next) throw new ChangedNote('Native bytes changed before verification.');
        const verified = parseThinking(document.file, readback);
        return {
          status: 'saved',
          phase,
          records: verified.records,
          originalRecords: originals,
          affectedRecords: affected,
          document: verified,
          retainedSource: source,
        };
      } catch (error) {
        return {
          status: dispatched ? 'possibly-saved' : source ? 'partial' : 'failed',
          phase,
          records: [],
          originalRecords: originals,
          attemptedRecords: dispatched ? affected : undefined,
          retainedSource: source,
          message: dispatched
            ? 'Possibly saved — open the native note to check. Do not blindly retry.'
            : error instanceof Error
              ? error.message
              : String(error),
        };
      }
    });
  }
  private allocate(raw: string, kind: string): string {
    const occupied = anchorCounts(raw);
    for (let index = 1; ; index++) {
      const id = `${kind}-${index}`;
      if (!occupied.has(id)) return id;
    }
  }
  private append(
    document: ThinkingDocument<File>,
    entries: Omit<
      ThinkingRecord,
      | 'path'
      | 'raw'
      | 'from'
      | 'to'
      | 'readOnly'
      | 'bodyFrom'
      | 'bodyTo'
      | 'connectionsFrom'
      | 'connectionsTo'
    >[],
  ): string {
    const newline = document.raw.includes('\r\n') ? '\r\n' : '\n';
    let next = document.raw;
    for (const entry of entries) {
      const blockId = entry.blockId || this.allocate(next, entry.kind);
      next +=
        (next.endsWith(newline + newline)
          ? ''
          : next.endsWith(newline)
            ? newline
            : newline + newline) + renderRecord({ ...entry, blockId }, newline);
    }
    return next;
  }
  private coalesce(
    key: string,
    operation: () => Promise<ThinkingResult<File>>,
  ): Promise<ThinkingResult<File>> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const result = operation();
    this.inFlight.set(key, result);
    const done = () => {
      if (this.inFlight.get(key) === result) this.inFlight.delete(key);
    };
    void result.then(done, done);
    return result;
  }
  keep(input: ThinkingKeep<File>): Promise<ThinkingResult<File>> {
    return this.coalesce(
      JSON.stringify([
        'keep',
        input.notebookPath,
        input.source.path,
        input.source.raw,
        input.from,
        input.to,
        input.comment,
      ]),
      () => this.keepNow(input),
    );
  }
  private keepNow(input: ThinkingKeep<File>): Promise<ThinkingResult<File>> {
    const request = { ...input, source: { ...input.source } };
    return this.track(
      this.actions.run('capture', async () => {
        let retained: Snapshot<File> | undefined;
        try {
          this.guard(request.guard);
          const selected = selectedSource(request.source.body, request.from, request.to);
          const occurrence = lookupContext(
            { kind: 'passage', ...selected, source: { path: request.source.path } },
            request.source.body,
          );
          if (occurrence.status !== 'exact')
            throw new Error(
              'The selected occurrence has ambiguous context. Open the source to inspect it.',
            );
          const document = await this.read(request.notebookPath);
          this.vault.assertWritable(document.file, document.raw);
          this.options.validateContainer?.('notebook', document.path, document.raw);
          if (document.issues.length)
            throw new Error(
              'The capture notebook has malformed or duplicate records. Open Markdown to inspect it.',
            );
          if (document.file === request.source.file)
            throw new Error('A source article cannot be its own capture notebook.');
          if (request.comment !== undefined && !request.comment.trim())
            throw new Error('Write a comment before saving.');
          const same = document.records.filter(
            (record) =>
              record.kind === 'passage' &&
              !record.readOnly &&
              record.before === selected.before &&
              record.after === selected.after &&
              record.source &&
              this.sameTarget(record.source, { path: request.source.path }, document.path, true),
          );
          if (same.some((record) => record.body !== selected.body))
            throw new Error(
              'An existing candidate snapshot was edited. Open the notebook before retrying capture.',
            );
          if (same.length > 1)
            throw new Error(
              'Several saved passages match. Open the notebook to inspect existing candidates.',
            );
          await this.validateSource(request.source, request.guard);
          if (same.length === 1 && request.comment === undefined)
            return {
              status: 'unchanged',
              phase: 'notebook',
              records: same,
              originalRecords: same,
              affectedRecords: same,
              document,
            };
          retained = await this.retain(request.source, request.guard);
          const source: ThinkingTarget = {
            path: retained.path,
            ...(existingSourceAnchor(retained.body, request.from, request.to)
              ? { blockId: existingSourceAnchor(retained.body, request.from, request.to) }
              : {}),
          };
          const collected = localCollectionDate(this.options.now?.());
          const blockId = same[0]?.blockId ?? this.allocate(document.raw, 'passage');
          const entries: Parameters<ThinkingStore<File>['append']>[1] = same.length
            ? []
            : [
                {
                  kind: 'passage',
                  ...selected,
                  source,
                  url:
                    typeof retained.properties.url === 'string'
                      ? retained.properties.url
                      : undefined,
                  collected,
                  blockId,
                  connections: [],
                },
              ];
          if (request.comment !== undefined)
            entries.push({
              kind: 'comment',
              body: request.comment,
              about: { path: document.path, blockId },
              collected,
              blockId: '',
              connections: [],
            });
          const next = this.append(document, entries);
          return await this.commit(document, next, 'notebook', request.guard, retained, same);
        } catch (error) {
          return this.failure(error, retained);
        }
      }),
    );
  }
  comment(input: ThinkingComment<File>): Promise<ThinkingResult<File>> {
    return this.coalesce(
      JSON.stringify([
        'comment',
        input.notebookPath,
        input.body,
        input.about,
        input.source?.path,
        input.source?.raw,
        input.gap,
      ]),
      () => this.commentNow(input),
    );
  }
  private commentNow(input: ThinkingComment<File>): Promise<ThinkingResult<File>> {
    const request = {
      ...input,
      source: input.source && { ...input.source },
      about: input.about && { ...input.about },
    };
    return this.track(
      this.actions.run('capture', async () => {
        let retained: Snapshot<File> | undefined;
        try {
          this.guard(request.guard);
          if (!request.body.trim()) throw new Error('Write a comment before saving.');
          if (request.about && request.source)
            throw new Error('Choose an attached comment or an independent source gap, not both.');
          const document = await this.read(request.notebookPath);
          this.vault.assertWritable(document.file, document.raw);
          this.options.validateContainer?.('notebook', document.path, document.raw);
          if (document.issues.length)
            throw new Error('The capture notebook needs native inspection before appending.');
          let context: { before?: string; after?: string } = {};
          if (request.source) {
            if (document.file === request.source.file)
              throw new Error('Comments must not rewrite their source article.');
            if (request.gap === undefined)
              throw new Error('Choose an explicit source paragraph gap.');
            context = sourceGap(request.source.body, request.gap);
            retained = await this.retain(request.source, request.guard);
          } else if (request.gap !== undefined) throw new Error('A gap requires a source article.');
          if (request.about) await this.validateTarget(request.about, document.path);
          const next = this.append(document, [
            {
              kind: 'comment',
              body: request.body,
              about: request.about,
              source: retained ? { path: retained.path } : undefined,
              ...context,
              url:
                retained && typeof retained.properties.url === 'string'
                  ? retained.properties.url
                  : undefined,
              collected: localCollectionDate(this.options.now?.()),
              connections: [],
              blockId: '',
            },
          ]);
          return await this.commit(document, next, 'notebook', request.guard, retained);
        } catch (error) {
          return this.failure(error, retained);
        }
      }),
    );
  }
  private sameTarget(
    a: ThinkingTarget,
    b: ThinkingTarget,
    sourcePath: string,
    fileOnly = false,
  ): boolean {
    const af = this.resolveTarget(a, sourcePath),
      bf = this.resolveTarget(b, sourcePath);
    if (this.vault.resolveLink && (!af || !bf)) return false;
    return (
      (af && bf ? af === bf : a.path.replace(/\.md$/i, '') === b.path.replace(/\.md$/i, '')) &&
      (fileOnly || a.blockId === b.blockId)
    );
  }
  private resolveTarget(target: ThinkingTarget, sourcePath: string): File | undefined {
    return this.vault.resolveLink
      ? this.vault.resolveLink(target.path, sourcePath)
      : (this.vault.file(target.path) ?? this.vault.file(target.path + '.md'));
  }
  private async validateTarget(target: ThinkingTarget, sourcePath: string): Promise<void> {
    targetLink(target);
    const file = this.resolveTarget(target, sourcePath);
    if (!file) throw new Error('The native target is unresolved. Open Markdown to inspect it.');
    if (target.blockId) {
      const doc = await this.read(file.path);
      const records = doc.records.filter(
        (record) => record.blockId === target.blockId && !record.readOnly,
      );
      if (records.length !== 1) throw new Error('The target entry is missing or read-only.');
    }
  }
  private freshRecord(document: ThinkingDocument<File>, original: ThinkingRecord): ThinkingRecord {
    const matches = document.records.filter((record) => record.blockId === original.blockId);
    if (
      matches.length !== 1 ||
      matches[0].readOnly ||
      matches[0].raw !== original.raw ||
      original.readOnly
    )
      throw new ChangedNote('The saved entry changed or is read-only. Reopen it before editing.');
    return matches[0];
  }
  editComment(input: {
    record: ThinkingRecord;
    body: string;
    guard?: () => void;
  }): Promise<ThinkingResult<File>> {
    const original = { ...input.record },
      body = input.body,
      guard = input.guard;
    return this.track(
      this.actions.run('edit', async () => {
        try {
          this.guard(guard);
          const document = await this.read(original.path),
            current = this.freshRecord(document, original);
          if (current.kind !== 'comment' || !body.trim())
            throw new Error('Only a nonempty comment body can be edited.');
          const newline = document.raw.includes('\r\n') ? '\r\n' : '\n';
          const quoted = quoteLines(body, newline).slice(2);
          const next =
            document.raw.slice(0, current.bodyFrom) + quoted + document.raw.slice(current.bodyTo);
          return await this.commit(document, next, 'notebook', guard, undefined, [original]);
        } catch (error) {
          return this.failure(error);
        }
      }),
    );
  }
  connect(input: {
    record: ThinkingRecord;
    target: ThinkingTarget;
    label?: string;
    /** Explicit structured-note creation flow only; ordinary Connect stays entry-only. */
    allowFileTarget?: boolean;
    guard?: () => void;
  }): Promise<ThinkingResult<File>> {
    const original = { ...input.record },
      target = { ...input.target },
      label = input.label?.trim(),
      guard = input.guard;
    return this.track(
      this.actions.run('edit', async () => {
        try {
          this.guard(guard);
          const document = await this.read(original.path),
            current = this.freshRecord(document, original);
          const connection: ThinkingConnection = { target, ...(label ? { label } : {}) };
          connectionLine(connection);
          if (
            this.sameTarget({ path: current.path, blockId: current.blockId }, target, current.path)
          )
            throw new Error('Choose another saved entry.');
          if (!target.blockId && !input.allowFileTarget)
            throw new Error('Explicit Thinking connections require a saved passage or comment.');
          await this.validateTarget(target, document.path);
          if (
            current.connections.some(
              (item) =>
                this.sameTarget(item.target, target, document.path) &&
                (item.label ?? '') === (label ?? ''),
            )
          )
            return {
              status: 'unchanged',
              phase: 'notebook',
              records: [current],
              originalRecords: [original],
              document,
            };
          const newline = document.raw.includes('\r\n') ? '\r\n' : '\n';
          const replacement = quoteLines(
            [...current.connections, connection].map(connectionLine).join('\n'),
            newline,
          ).slice(2);
          const next =
            document.raw.slice(0, current.connectionsFrom) +
            replacement +
            document.raw.slice(current.connectionsTo);
          return await this.commit(document, next, 'notebook', guard, undefined, [original]);
        } catch (error) {
          return this.failure(error);
        }
      }),
    );
  }
  editConnection(input: {
    record: ThinkingRecord;
    connection: ThinkingConnection;
    label?: string;
    remove?: boolean;
    guard?: () => void;
  }): Promise<ThinkingResult<File>> {
    const original = { ...input.record },
      connection = { ...input.connection, target: { ...input.connection.target } };
    const label = input.label?.trim(),
      remove = input.remove,
      guard = input.guard;
    return this.track(
      this.actions.run('edit', async () => {
        try {
          this.guard(guard);
          const document = await this.read(original.path),
            current = this.freshRecord(document, original);
          const matches = current.connections
            .map((item, index) => ({ item, index }))
            .filter(
              ({ item }) =>
                this.sameTarget(item.target, connection.target, document.path) &&
                item.label === connection.label,
            );
          if (matches.length !== 1)
            throw new ChangedNote('The connection changed or is ambiguous.');
          const nextConnections = [...current.connections];
          if (remove) nextConnections.splice(matches[0].index, 1);
          else {
            const edited = { target: matches[0].item.target, ...(label ? { label } : {}) };
            connectionLine(edited);
            if (
              nextConnections.some(
                (item, index) =>
                  index !== matches[0].index &&
                  this.sameTarget(item.target, edited.target, document.path) &&
                  (item.label ?? '') === (label ?? ''),
              )
            )
              throw new Error('That connection already exists.');
            nextConnections[matches[0].index] = edited;
          }
          const newline = document.raw.includes('\r\n') ? '\r\n' : '\n';
          const replacement = quoteLines(
            nextConnections.length ? nextConnections.map(connectionLine).join('\n') : '_None._',
            newline,
          ).slice(2);
          const next =
            document.raw.slice(0, current.connectionsFrom) +
            replacement +
            document.raw.slice(current.connectionsTo);
          return await this.commit(document, next, 'notebook', guard, undefined, [original]);
        } catch (error) {
          return this.failure(error);
        }
      }),
    );
  }
  editExploration(input: ThinkingExplorationEdit<File>): Promise<ThinkingResult<File>> {
    const request = { ...input, document: { ...input.document } };
    return this.track(
      this.actions.run('exploration', async () => {
        let retained: Snapshot<File> | undefined;
        try {
          this.guard(request.guard);
          const document = await this.read(request.document.path);
          if (document.file !== request.document.file || document.raw !== request.document.raw)
            throw new ChangedNote();
          this.options.validateContainer?.('exploration', document.path, document.raw);
          this.vault.assertWritable(document.file, document.raw);
          const newline = document.raw.includes('\r\n') ? '\r\n' : '\n';
          let next = document.raw;
          if (request.action === 'add') {
            targetLink(request.target);
            await this.validateTarget(request.target, document.path);
            if (
              document.memberships.some((item) =>
                this.sameTarget(item.target, request.target, document.path),
              )
            )
              return {
                status: 'unchanged',
                phase: 'exploration',
                records: [],
                originalRecords: [],
                document,
              };
            if (request.source) {
              if (
                !this.sameTarget(request.target, { path: request.source.path }, document.path, true)
              )
                throw new Error('The retained source does not match the inclusion.');
              retained = await this.retain(request.source, request.guard);
            } else if (!request.target.blockId) {
              const file = this.resolveTarget(request.target, document.path);
              if (file) {
                const raw = await this.vault.read(file),
                  doc = readDocument(raw);
                if (doc.properties.type === 'article')
                  retained = await this.retain(
                    { file, path: file.path, raw, body: doc.body, properties: doc.properties },
                    request.guard,
                  );
              }
            }
            const target = retained ? { ...request.target, path: retained.path } : request.target;
            next +=
              (next.endsWith(newline + newline)
                ? ''
                : next.endsWith(newline)
                  ? newline
                  : newline + newline) +
              `- ${targetLink(target)}` +
              newline;
          } else if (request.action === 'remove') {
            const item = document.memberships.find(
              (item) =>
                item.from === request.membership.from &&
                item.to === request.membership.to &&
                item.raw === request.membership.raw,
            );
            if (!item || document.raw.slice(item.from, item.to) !== item.raw)
              throw new ChangedNote('The selected membership changed.');
            next = next.slice(0, item.from) + next.slice(item.to);
          } else if (request.action === 'reorder') {
            const { memberships, order } = request;
            if (
              !memberships.length ||
              order.length !== memberships.length ||
              new Set(order).size !== order.length ||
              order.some(
                (index) => !Number.isInteger(index) || index < 0 || index >= memberships.length,
              )
            )
              throw new Error('Select each membership exactly once for reordering.');
            const selected = memberships.map((item) =>
              document.memberships.find(
                (current) =>
                  current.from === item.from && current.to === item.to && current.raw === item.raw,
              ),
            );
            if (
              selected.some((item) => !item) ||
              new Set(selected.map((item) => item!.from)).size !== selected.length
            )
              throw new ChangedNote('The selected memberships changed.');
            const sorted = selected.map((item) => item!).sort((a, b) => a.from - b.from);
            for (let index = sorted.length - 1; index >= 0; index--) {
              const slot = sorted[index],
                replacement = selected[order[index]]!.raw.replace(/(?:\r?\n)?$/, '');
              const ending = /\r?\n$/.exec(slot.raw)?.[0] ?? '';
              next = next.slice(0, slot.from) + replacement + ending + next.slice(slot.to);
            }
          } else {
            const headerEnd = readDocument(next).headerEnd;
            if (
              !Number.isInteger(request.from) ||
              !Number.isInteger(request.to) ||
              request.from < headerEnd ||
              request.to < request.from ||
              request.to > next.length ||
              next.slice(request.from, request.to) !== request.expected
            )
              throw new ChangedNote('The selected exploration prose changed.');
            next = next.slice(0, request.from) + request.text + next.slice(request.to);
          }
          return await this.commit(document, next, 'exploration', request.guard, retained);
        } catch (error) {
          return { ...this.failure(error, retained), phase: 'exploration' };
        }
      }),
    );
  }
  async search(
    paths: readonly string[],
    query: string,
    options: ThinkingSearchOptions = {},
  ): Promise<ThinkingSearchResult> {
    const hits: ThinkingSearchResult['hits'] = [];
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const maxReads = Math.max(0, Math.min(500, options.maxReads ?? 100));
    const unique = [...new Set(paths)].filter((path) => !excludedReaderPath(path));
    const needle = query.trim().toLocaleLowerCase();
    let inspected = 0,
      cancelled = false,
      coverage = true;
    const current = () => {
      try {
        this.guard(options.guard);
        return !options.signal?.aborted;
      } catch {
        return false;
      }
    };
    for (const path of unique) {
      if (!current()) {
        cancelled = true;
        break;
      }
      if (inspected >= maxReads || hits.length >= limit) break;
      inspected++;
      try {
        const document = await this.read(path, () => {
          if (!current()) throw new Error('Search cancelled.');
        });
        if (!current()) {
          cancelled = true;
          break;
        }
        if (document.issues.length) coverage = false;
        const doc = readDocument(document.raw);
        if (doc.properties.type === 'article') {
          if (
            !needle ||
            doc.body.toLocaleLowerCase().includes(needle) ||
            path.toLocaleLowerCase().includes(needle)
          )
            hits.push({ path, evidence: 'literal', text: doc.body.slice(0, 500) });
        } else {
          if (
            !document.records.length &&
            (!needle ||
              doc.body.toLocaleLowerCase().includes(needle) ||
              path.toLocaleLowerCase().includes(needle))
          )
            hits.push({ path, evidence: 'literal', text: doc.body.slice(0, 500) });
          for (const record of document.records) {
            if (hits.length >= limit) break;
            if (!needle || record.body.toLocaleLowerCase().includes(needle))
              hits.push({ path, record, evidence: 'literal', text: record.body.slice(0, 500) });
            else if (
              record.source &&
              targetLink(record.source).toLocaleLowerCase().includes(needle)
            )
              hits.push({ path, record, evidence: 'source-link', text: record.body.slice(0, 500) });
          }
        }
      } catch {
        coverage = false;
        if (!current()) {
          cancelled = true;
          break;
        }
      }
    }
    return {
      hits,
      inspected,
      complete: coverage && !cancelled && inspected === unique.length,
      cancelled,
    };
  }
  context(record: ThinkingRecord, source: Snapshot<File>) {
    if (!record.source || !this.sameTarget(record.source, { path: source.path }, record.path, true))
      return { status: 'missing' as const, snapshot: record.body, source: record.source };
    return lookupContext(record, source.body);
  }
}
