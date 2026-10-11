import type { Article, ArticleStatus, ExtractedArticle, Feed, FileStore, NewArticle, ReaderSettings } from '../types';
import { StorageContext } from './context';
import { setHighlightType } from './typed-highlights';
import { validReadingPosition, type ReadingPosition } from '../reading-position';
import { StaleArticleWriteError, type AcquisitionWriteOptions } from './preconditions';
import type { ArticleTemplateExclusionsSource } from './classifier';
import * as feeds from './feeds';
import * as highlights from './highlights';
import * as highlightMutations from './highlight-mutations';
import * as topics from './topics';
import { newNote, parseNote, writeNote } from './markdown';
import { assertInlineNote, LegacyStorageError, prepareInlineStorage, type ConversionReport } from './legacy-import';
import { checkStatus } from './models';
import { normalizeUrl, queued, sameUrl } from './safety';
import { articlePath, knownPublication } from './article-path';
import { moveArticle } from './moves';
import { capturePathGenerations, invalidatePaths, pathGeneration } from './path-generation';
import { saveExtractedSource, type SaveContentOptions } from './source';

/** Markdown and frontmatter are the sole active storage format. */
export class ReaderRepository {
  private readonly context: StorageContext;
  constructor(store: FileStore, settings: ReaderSettings, templateExclusions: ArticleTemplateExclusionsSource = {}) {
    this.context = new StorageContext(store, settings, templateExclusions);
  }

  articleGeneration(path: string): number { return pathGeneration(this.context.store, path); }
  suspendStorage(message: string): void { this.context.suspend(message); }
  disposeStorage(): void { this.context.store.dispose?.(); }
  async articleRenamed(from: string, to: string): Promise<void> {
    invalidatePaths(this.context.store, from, to);
    try {
      await this.context.assertWritable(from);
      assertInlineNote(await this.context.read(to), to);
    } catch (error) {
      if (!(error instanceof LegacyStorageError) && !(await this.context.store.exists(from))) return;
      this.context.blockLegacy(from, 'a renamed note has legacy ownership evidence at its previous path');
      this.context.blockLegacy(to, 'a renamed note may still be owned by legacy data at its previous path');
    }
  }

  async articleDeleted(path: string): Promise<void> {
    invalidatePaths(this.context.store, path);
    try { await this.context.assertWritable(path); }
    catch { this.context.blockLegacy(path, 'deleted note path is still implicated by legacy ownership evidence; do not recreate it before review'); }
  }

  /** Read-only inventory of unsupported legacy data; files are never normalized or deleted. */
  prepareStorage(): Promise<ConversionReport> {
    return queued(this.context.store, () => prepareInlineStorage(this.context));
  }

  async listArticles(): Promise<Article[]> {
    const result: Article[] = [], files = await this.context.store.list();
    for (const { path, note } of await this.context.scan()) {
      if (!this.context.isArticle(note, path)) continue;
      const article = this.context.article(note, path, files);
      if (article.status) result.push(article);
    }
    return result;
  }
  async getArticle(path: string): Promise<Article> {
    const raw = await this.context.store.read(path);
    return { ...this.context.article(parseNote(raw), path, await this.context.store.list()), revision: raw };
  }
  saveReadingPosition(path: string, position: ReadingPosition, expectedId: string, expectedGeneration = this.articleGeneration(path)): Promise<string> {
    const valid = validReadingPosition(position);
    if (!valid) return Promise.reject(new Error('Invalid reading position'));
    const options = { expectedId, expectedGeneration };
    return queued(this.context.store, async () => (await this.context.saveReadingPosition(path, valid, options)).id);
  }
  /** Return the committed raw bytes to guard the next debounced position write. */
  saveReadingPositionRevision(path: string, position: ReadingPosition, expectedId: string, expectedGeneration: number, expectedRevision: string): Promise<{ id: string; revision: string }> {
    const valid = validReadingPosition(position);
    if (!valid) return Promise.reject(new Error('Invalid reading position'));
    return queued(this.context.store, () => this.context.saveReadingPosition(path, valid,
      { expectedId, expectedGeneration, expectedRevision }));
  }

  listTopics(): Promise<topics.TopicOption[]> { return topics.listTopics(this.context); }
  listAuthors(): Promise<topics.TopicOption[]> { return topics.listAuthors(this.context); }
  updateArticleTopics(path: string, delta: topics.TopicDelta, expected: import('./relationships').RelationshipExpectation = {}): Promise<Article> {
    const options = { expectedGeneration: this.articleGeneration(path), ...expected };
    return queued(this.context.store, async () => {
      await topics.updateArticleTopics(this.context, path, delta, options);
      return this.getArticle(path);
    });
  }
  updateArticleAuthors(path: string, delta: topics.TopicDelta, expected: import('./relationships').RelationshipExpectation = {}): Promise<Article> {
    const options = { expectedGeneration: this.articleGeneration(path), ...expected };
    return queued(this.context.store, async () => {
      await topics.updateArticleAuthors(this.context, path, delta, options);
      return this.getArticle(path);
    });
  }

  createArticle(input: NewArticle): Promise<Article> {
    const generationAtRequest = capturePathGenerations(this.context.store);
    return queued(this.context.store, async () => {
      const url = input.url.trim() ? normalizeUrl(input.url) : '';
      // Feed imports deduplicate by URL, not by persisted GUID.
      const existing = input.feed?.trim() && url ? (await this.listArticles()).find(article => sameUrl(article.url, url)) : undefined;
      // Re-import must not change status, extracted snapshots, highlights, or user metadata.
      if (existing) {
        await this.context.mutate(existing.path, 'article', note => { this.context.article(note, existing.path); return false; });
        return this.getArticle(existing.path);
      }
      checkStatus(input.status ?? 'inbox');
      const supplied = input.feedText;
      if (supplied && (typeof supplied.markdown !== 'string' || !supplied.markdown.trim() || typeof supplied.isExcerpt !== 'boolean'))
        throw new Error('Feed text must include nonempty Markdown and an explicit excerpt classification');
      if (supplied && input.body !== undefined && input.body !== supplied.markdown)
        throw new Error('Conflicting body and supplied feed text; preserved input without creating an article');
      const body = supplied?.markdown ?? input.body ?? '';
      const feed = input.feed ? (await feeds.listFeeds(this.context)).find(item => input.feed === '[[' + item.path.replace(/\.md$/i, '') + ']]') : undefined;
      const path = articlePath(input, await this.context.store.list(), input.feedPrefix?.trim() || feed?.prefix || feed?.title);
      const properties: Record<string, unknown> = { type: 'article', url: input.url.trim() };
      if (input.title.trim()) properties.title = input.title.trim();
      if (input.feed !== undefined) properties.feed = input.feed;
      const published = knownPublication(input.published);
      if (published) properties.published = published;
      if (input.summary !== undefined) properties.summary = input.summary;
      const note = newNote(properties, body);
      const article = this.context.article(note, path);
      const ownershipRevision = await this.context.assertWritable(path);
      await this.context.store.create(path, writeNote(note), { guard: () => {
        this.context.assertOwnershipRevision(path, ownershipRevision);
        this.context.assertWritableNow(path);
        if (this.articleGeneration(path) !== generationAtRequest(path)) throw new StaleArticleWriteError();
      } });
      return article;
    });
  }

  setStatus(path: string, status: ArticleStatus): Promise<Article> {
    return queued(this.context.store, async () => {
      checkStatus(status);
      return moveArticle(this.context, path, status);
    });
  }

  saveContent(path: string, result: ExtractedArticle, options: SaveContentOptions = {}): Promise<Article> {
    const requestOptions = { ...options };
    return queued(this.context.store, async () => {
      let saved = false;
      await this.context.mutate(path, 'article', note => {
        const article = this.context.article(note, path);
        saved = saveExtractedSource(note, result, article.highlights.length, requestOptions);
        return saved;
      }, requestOptions);
      const article = await this.getArticle(path);
      return saved && !article.error?.startsWith('Snapshot protected:')
        ? { ...article, content: result.status, extractor: result.extractor } : article;
    });
  }

  setArticleError(path: string, message: string, retryAfter?: string, options: AcquisitionWriteOptions = {}): Promise<void> {
    const requestOptions = { ...options };
    return queued(this.context.store, () => this.context.mutate(path, 'article', note => {
      const article = this.context.article(note, path);
      if (retryAfter !== undefined && Number.isNaN(Date.parse(retryAfter))) throw new Error('Invalid retry timestamp');
      note.doc.set('error', message);
      if (retryAfter !== undefined && article.content !== 'protected') note.doc.set('retryAfter', retryAfter);
      else note.doc.delete('retryAfter');
    }, requestOptions));
  }

  addHighlight(path: string, input: highlights.HighlightInput): Promise<Article> {
    const options = { expectedGeneration: this.articleGeneration(path) };
    return queued(this.context.store, async () => {
      await highlights.addHighlight(this.context, path, input, options);
      return this.getArticle(path);
    });
  }
  setHighlightType(path: string, id: string, type: import('../typed-highlights').TypedHighlightType): Promise<Article> {
    const options = { expectedGeneration: this.articleGeneration(path) };
    return queued(this.context.store, async () => {
      await setHighlightType(this.context, path, id, type, options);
      return this.getArticle(path);
    });
  }
  setHighlightLink(path: string, id: string, target: string): Promise<Article> {
    const options = { expectedGeneration: this.articleGeneration(path) };
    return queued(this.context.store, async () => {
      await highlightMutations.setHighlightLink(this.context, path, id, target, options);
      return this.getArticle(path);
    });
  }
  deleteHighlight(path: string, id: string): Promise<Article> {
    const options = { expectedGeneration: this.articleGeneration(path) };
    return queued(this.context.store, async () => {
      await highlightMutations.deleteHighlight(this.context, path, id, options);
      return this.getArticle(path);
    });
  }
  addLink(path: string, input: highlights.HighlightInput, target: string): Promise<Article> {
    const options = { expectedGeneration: this.articleGeneration(path) };
    return queued(this.context.store, async () => {
      await highlightMutations.addLink(this.context, path, input, target, options);
      return this.getArticle(path);
    });
  }
  setLink(path: string, id: string, target: string): Promise<Article> {
    const options = { expectedGeneration: this.articleGeneration(path) };
    return queued(this.context.store, async () => {
      await highlightMutations.setLink(this.context, path, id, target, options);
      return this.getArticle(path);
    });
  }
  deleteLink(path: string, id: string): Promise<Article> {
    const options = { expectedGeneration: this.articleGeneration(path) };
    return queued(this.context.store, async () => {
      await highlightMutations.deleteLink(this.context, path, id, options);
      return this.getArticle(path);
    });
  }
  listFeeds(): Promise<Feed[]> { return feeds.listFeeds(this.context); }
  createFeed(title: string, url: string): Promise<Feed> {
    const generationAtRequest = capturePathGenerations(this.context.store);
    return queued(this.context.store, () => feeds.createFeed(this.context, title, url, generationAtRequest));
  }
  updateFeed(path: string, patch: Partial<Feed>): Promise<void> {
    return queued(this.context.store, () => feeds.updateFeed(this.context, path, patch));
  }
}
