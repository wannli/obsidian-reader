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

const managedProperties = new Set(['type', 'title', 'url', 'status', 'summary', 'retryAfter', 'error',
  'feed', 'published', 'topics', 'enabled', 'prefix', 'articleSection',
  'sourceLayoutHash', 'sourceLayoutLength']);
function protectedProperties(note: Note, positionOnly: boolean, propertyOnly?: 'topics' | 'authors'): string {
  return JSON.stringify(Object.fromEntries(Object.entries(note.doc.toJS({ maxAliasCount: 50 })).filter(([key]) => propertyOnly ? key !== propertyOnly : positionOnly
    ? !['reading_position'].includes(key)
    : !(managedProperties.has(key) || (noteType(note) === 'feed' && key === 'id')))));
}
export interface StoredNote { path: string; note: Note; }
export class StorageContext {
  private suspended?: string;
  constructor(readonly store: FileStore, readonly settings: ReaderSettings, private readonly exclusions: ArticleTemplateExclusionsSource = {}) {}
  suspend(message: string): void { this.suspended = message; }
  assertActive(): void { if (this.suspended) throw new Error(this.suspended); }
  assertWritableNow(_path: string): void { this.assertActive(); }
  async assertWritable(path: string): Promise<number> { this.assertActive(); return this.store.revision(path); }
  assertRevision(path: string, revision: number): void {
    if (this.store.revision(path) !== revision) throw new StaleArticleWriteError();
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
  async saveReadingPosition(path: string, position: ReadingPosition, options: { expectedGeneration: number; expectedRevision?: string }): Promise<{ revision: string }> {
    const valid = validReadingPosition(position);
    if (!valid) throw new Error('Invalid reading position');
    const expected = { expectedGeneration: options.expectedGeneration, expectedRevision: options.expectedRevision };
    if (!Number.isSafeInteger(expected.expectedGeneration) || expected.expectedGeneration < 0)
      throw new StaleArticleWriteError();
    let revision: string | undefined;
    await this.mutateNote(path, 'article', note => {
      const current = note.doc.get('reading_position');
      if (current === valid.marker) return false;
      if (current !== undefined && !readingPosition(current))
        throw new Error('Unsupported reading_position value; preserved the note');
      const marker = new Scalar(valid.marker);
      marker.type = Scalar.QUOTE_DOUBLE;
      note.doc.set('reading_position', marker);
    }, expected, true, undefined, raw => { revision = raw; });
    return { revision: revision! };
  }

  private async mutateNote(path: string, type: 'article' | 'feed', update: (note: Note) => boolean | void, options: AcquisitionWriteOptions, positionOnly: boolean, propertyOnly?: 'topics' | 'authors', savedRaw?: (raw: string) => void): Promise<string> {
    const expectedUrl = options.expectedUrl;
    let resultId = '';
    safePath(path, true);
    const revision = await this.assertWritable(path);
    const others = type === 'feed' ? (await this.scan()).filter(item => item.path !== path && noteType(item.note) === 'feed') : [];
    const ids = others.map(item => stringField(item.note, 'id')).filter((id): id is string => !!id);
    await this.store.process(path, current => {
      this.assertWritableNow(path);
      if (options.expectedRevision !== undefined && current !== options.expectedRevision) throw new StaleArticleWriteError();
      const note = parseNote(current);
      // Run before classification, identity allocation, or any update callback.
      assertExpectedArticleUrl(note, expectedUrl);
      if (options.expectedGeneration !== undefined && pathGeneration(this.store, path) !== options.expectedGeneration) throw new StaleArticleWriteError();
      if (type === 'article') {
        if (!this.isArticle(note, path)) throw new Error('Expected an article note; templates and ordinary notes are preserved');
        if (options.expectedBody !== undefined && this.article(note, path).body !== options.expectedBody) throw new StaleArticleWriteError();
      } else expectType(note, type);
      const existing = type === 'feed' ? note.doc.get('id') : undefined;
      if (existing !== undefined && (typeof existing !== 'string' || !existing.trim())) throw new Error('Invalid note ID');
      if (typeof existing === 'string' && ids.includes(existing)) throw new Error('Duplicate note ID: ' + existing);
      const protectedBefore = protectedProperties(note, positionOnly, propertyOnly), body = note.body;
      const changed = update(note);
      // A veto is a true no-op.
      if (changed === false) { resultId = typeof existing === 'string' ? existing : ''; savedRaw?.(current); return current; }
      // Let note-specific stale-source checks report first, then fence any
      // cross-path change that arrived during the awaited operation.
      this.assertRevision(path, revision);
      if (!propertyOnly && type === 'feed') {
        if (!existing) note.doc.set('id', uniqueId(type, ids));
      }
      if (protectedProperties(note, positionOnly, propertyOnly) !== protectedBefore || ((positionOnly || propertyOnly) && note.body !== body))
        throw new Error(positionOnly
          ? 'Reading-position write would change protected/custom properties or body; preserved the note'
          : 'Shared YAML aliases would change custom properties; preserved the note');
      resultId = type === 'feed' ? stringField(note, 'id') ?? '' : '';
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

  async freshId(type: 'feed'): Promise<string> {
    return uniqueId(type, (await this.scan()).filter(item => noteType(item.note) === 'feed').map(item => stringField(item.note, 'id') ?? ''));
  }
}

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
