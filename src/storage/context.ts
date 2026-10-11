import { Scalar } from 'yaml';
import { writeRelationship } from './relationship-markdown';
import type { Article, FileStore, ReaderSettings } from '../types';
import { readingPosition, validReadingPosition, type ReadingPosition } from '../reading-position';
import { isArticleNote, isArticleTemplatePath, type ArticleTemplateExclusions, type ArticleTemplateExclusionsSource } from './classifier';
import { articleFrom } from './models';
import { expectType, noteType, parseNote, stringField, writeNote, type Note } from './markdown';
import { safePath, uniqueId } from './safety';
import { assertExpectedArticleUrl, StaleArticleWriteError, type AcquisitionWriteOptions } from './preconditions';
import { pathGeneration } from './path-generation';
import { assertInlineNote, assertNoLegacySidecar, INLINE_FORMAT, LegacyStorageError } from './legacy-import';
import { discoverLegacyBlocks } from './legacy-discovery';

const managedProperties = new Set(['type', 'id', 'created-by', 'title', 'url', 'status', 'content', 'extractor', 'summary', 'retryAfter', 'error',
  'feed', 'guid', 'published', 'topics', 'checked', 'etag', 'modified', 'enabled', 'prefix', 'articleSection',
  'sourceHash', 'sourceLength', 'sourceLayoutHash', 'sourceLayoutLength', 'pullmanFormat']);
function protectedProperties(note: Note, positionOnly: boolean, propertyOnly?: 'topics' | 'authors'): string {
  return JSON.stringify(Object.fromEntries(Object.entries(note.doc.toJS({ maxAliasCount: 50 })).filter(([key]) => propertyOnly ? key !== propertyOnly : positionOnly
    ? !['reading_position', 'id', 'pullmanFormat'].includes(key)
    : !managedProperties.has(key))));
}
export interface StoredNote { path: string; note: Note; }
export class StorageContext {
  private suspended?: string;
  private legacyBlocks = new Map<string, string>();
  constructor(readonly store: FileStore, readonly settings: ReaderSettings, private readonly exclusions: ArticleTemplateExclusionsSource = {}) {}
  suspend(message: string): void { this.suspended = message; }
  blockLegacy(path: string, message: string): void { this.legacyBlocks.set(safePath(path, true), message); }
  resetLegacyBlocks(): void { this.legacyBlocks.clear(); }
  hasLegacyBlock(path: string): boolean { return this.legacyBlocks.has(path); }
  assertActive(): void { if (this.suspended) throw new Error(this.suspended); }
  async refreshLegacyBlocks(paths: string[]): Promise<string[]> {
    const errors = await discoverLegacyBlocks(this, paths);
    for (const file of paths.filter(path => /\.md$/i.test(path))) {
      try {
        const note = parseNote(await this.store.read(file));
        const move = note.doc.toJS({ maxAliasCount: 50 }).queueMove as Record<string, unknown> | undefined;
        if (move && typeof move === 'object') {
          const detail = 'pending YAML queueMove requires manual review; preserve both paths';
          this.blockLegacy(file, detail);
          errors.push(file + ': ' + detail);
          for (const destination of [move.from, move.to]) if (typeof destination === 'string') {
            try { const safe = safePath(destination, true); this.blockLegacy(safe, detail); }
            catch { /* malformed targets cannot safely identify an additional path */ }
          }
        }
        if (this.isArticle(note, file) || note.doc.get('type') === 'feed') {
          try { assertInlineNote(note, file); }
          catch (error) {
            if (error instanceof LegacyStorageError) { this.blockLegacy(file, error.message); errors.push(file + ': ' + error.message); }
          }
        }
      } catch { /* malformed/unrelated notes remain untouched and are handled by their own readers */ }
    }
    return errors;
  }

  assertWritableNow(path: string): void {
    this.assertActive();
    const block = this.legacyBlocks.get(path);
    if (block) throw new LegacyStorageError(path, block);
  }

  async assertWritable(path: string): Promise<number> {
    this.assertActive();
    // Creates and moves re-inventory cross-path legacy ownership before dispatch.
    const beforeInventory = this.store.revision(path);
    await this.refreshLegacyBlocks(await this.store.list());
    this.assertWritableNow(path);
    await assertNoLegacySidecar(this.store, path);
    const revision = this.store.revision(path);
    if (revision !== beforeInventory)
      throw new LegacyStorageError(path, 'vault changed during legacy ownership review; retry after storage is rechecked');
    return revision;
  }

  assertOwnershipRevision(path: string, revision: number): void {
    if (this.store.revision(path) !== revision)
      throw new LegacyStorageError(path, 'vault changed after legacy ownership review; retry after storage is rechecked');
  }

  async assertNoteWritable(path: string): Promise<number> {
    // Ordinary edits must refresh cross-path ownership too: another note or
    // orphan record may have declared this path as a move endpoint since start.
    const beforeInventory = this.store.revision(path);
    await this.refreshLegacyBlocks(await this.store.list());
    this.assertWritableNow(path);
    await assertNoLegacySidecar(this.store, path);
    const revision = this.store.revision(path);
    if (revision !== beforeInventory)
      throw new LegacyStorageError(path, 'vault changed during legacy ownership review; retry after storage is rechecked');
    return revision;
  }

  get templateExclusions(): ArticleTemplateExclusions {
    return (typeof this.exclusions === 'function' ? this.exclusions() : this.exclusions) ?? {};
  }
  isTemplate(path: string): boolean { return isArticleTemplatePath(path, this.templateExclusions); }

  isArticle(note: Note, path: string): boolean {
    return isArticleNote(path, note.doc.toJS({ maxAliasCount: 50 }), this.templateExclusions);
  }
  article(note: Note, path: string, files: readonly string[] = []): Article {
    return articleFrom(note, path, files, this.templateExclusions);
  }

  async scan(onError?: (path: string, error: unknown) => void): Promise<StoredNote[]> {
    const notes: StoredNote[] = [];
    for (const path of await this.store.list()) {
      if (!/\.md$/i.test(path)) continue;
      try {
        safePath(path, true);
        const note = parseNote(await this.store.read(path));
        if (this.isArticle(note, path) || noteType(note) === 'feed') notes.push({ path, note });
      } catch (error) {
        if (error instanceof LegacyStorageError && !onError) throw error;
        onError?.(path, error);
      }
    }
    return notes;
  }

  async read(path: string): Promise<Note> { return parseNote(await this.store.read(safePath(path, true))); }

  async mutate(path: string, type: 'article' | 'feed', update: (note: Note) => boolean | void, options: AcquisitionWriteOptions = {}): Promise<void> {
    await this.mutateNote(path, type, update, options, false);
  }

  async mutateRelationship(path: string, property: 'topics' | 'authors', update: (note: Note) => boolean, options: AcquisitionWriteOptions): Promise<void> {
    await this.mutateNote(path, 'article', update, options, false, property);
  }

  /** Only this writer may change reading_position. Other operations must keep
   * treating it as custom YAML, including shared-alias side effects. */
  async saveReadingPosition(path: string, position: ReadingPosition, options: { expectedId: string; expectedGeneration: number; expectedRevision?: string }): Promise<{ id: string; revision: string }> {
    const valid = validReadingPosition(position);
    if (!valid) throw new Error('Invalid reading position');
    const expected = { expectedId: options.expectedId, expectedGeneration: options.expectedGeneration, expectedRevision: options.expectedRevision };
    if (typeof expected.expectedId !== 'string' || !Number.isSafeInteger(expected.expectedGeneration) || expected.expectedGeneration < 0)
      throw new StaleArticleWriteError();
    let revision: string | undefined;
    const id = await this.mutateNote(path, 'article', note => {
      const current = note.doc.get('reading_position');
      if (current === valid.marker) return false;
      if (current !== undefined && !readingPosition(current))
        throw new Error('Unsupported reading_position value; preserved the note');
      const marker = new Scalar(valid.marker);
      marker.type = Scalar.QUOTE_DOUBLE;
      note.doc.set('reading_position', marker);
    }, expected, true, undefined, raw => { revision = raw; });
    return { id, revision: revision! };
  }

  private async mutateNote(path: string, type: 'article' | 'feed', update: (note: Note) => boolean | void, options: AcquisitionWriteOptions, positionOnly: boolean, propertyOnly?: 'topics' | 'authors', savedRaw?: (raw: string) => void): Promise<string> {
    const expectedUrl = options.expectedUrl;
    let resultId = '';
    safePath(path, true);
    const ownershipRevision = await this.assertNoteWritable(path);
    const others = (await this.scan()).filter(item => item.path !== path);
    const ids = others.map(item => stringField(item.note, 'id')).filter((id): id is string => !!id);
    await this.store.process(path, current => {
      this.assertWritableNow(path);
      if (options.expectedRevision !== undefined && current !== options.expectedRevision) throw new StaleArticleWriteError();
      const note = parseNote(current);
      assertInlineNote(note, path);
      // Run before classification, identity allocation, or any update callback.
      assertExpectedArticleUrl(note, expectedUrl);
      if ((options.expectedId !== undefined && (stringField(note, 'id') ?? '') !== options.expectedId) ||
          (options.expectedGeneration !== undefined && pathGeneration(this.store, path) !== options.expectedGeneration)) throw new StaleArticleWriteError();
      if (type === 'article') {
        if (!this.isArticle(note, path)) throw new Error('Expected an article note; templates and ordinary notes are preserved');
        if (options.expectedBody !== undefined && this.article(note, path).body !== options.expectedBody) throw new StaleArticleWriteError();
      } else expectType(note, type);
      const existing = note.doc.get('id');
      if (existing !== undefined && (typeof existing !== 'string' || !existing.trim())) throw new Error('Invalid note ID');
      if (typeof existing === 'string' && ids.includes(existing)) throw new Error('Duplicate note ID: ' + existing);
      const protectedBefore = protectedProperties(note, positionOnly, propertyOnly), body = note.body;
      const changed = update(note);
      // A veto is a true no-op even for legacy/native notes without an ID.
      if (changed === false) { resultId = typeof existing === 'string' ? existing : ''; savedRaw?.(current); return current; }
      // Let note-specific stale-source checks report first, then fence any
      // cross-path ownership change that arrived during the awaited operation.
      if (this.store.revision(path) !== ownershipRevision)
        throw new LegacyStorageError(path, 'vault changed after legacy ownership review; retry after storage is rechecked');
      if (!propertyOnly && type === 'feed') {
        if (!existing) note.doc.set('id', uniqueId(type, ids));
        note.doc.set('pullmanFormat', INLINE_FORMAT);
      }
      if (protectedProperties(note, positionOnly, propertyOnly) !== protectedBefore || ((positionOnly || propertyOnly) && note.body !== body))
        throw new Error(positionOnly
          ? 'Reading-position write would change protected/custom properties or body; preserved the note'
          : 'Shared YAML aliases would change custom properties; preserved the note');
      resultId = stringField(note, 'id') ?? '';
      if (propertyOnly) {
        const result = writeRelationship(current, note, propertyOnly), verified = parseNote(result);
        if (verified.body !== note.body || JSON.stringify(verified.doc.toJS({ maxAliasCount: 50 })) !== JSON.stringify(note.doc.toJS({ maxAliasCount: 50 })))
          throw new Error('Cannot safely update relationship YAML; preserved the note');
        return result;
      }
      const result = writeNote(note);
      savedRaw?.(result);
      return result;
    });
    return resultId;
  }

  async freshId(type: 'article' | 'feed'): Promise<string> {
    return uniqueId(type, (await this.scan()).map(item => stringField(item.note, 'id') ?? ''));
  }
}

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
