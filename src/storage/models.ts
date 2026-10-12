import { readingPosition } from '../reading-position';
import { statusFromPath } from '../reading-layout';
import type { Article, ArticleStatus, ContentState, Feed, Highlight } from '../types';
import { expectType, stringField, titleOf, type Note } from './markdown';
import { parseInlineMarkdown } from '../inline/parser';
import { displayedSource, extractorOf, sourceRegion } from './source';
import { readTopics, relationshipRevision } from './topic-links';
import { isArticleNote, type ArticleTemplateExclusions } from './classifier';

const statuses: ArticleStatus[] = ['feed', 'inbox', 'later', 'archive'];
const states: ContentState[] = ['pending', 'ready', 'partial', 'error', 'protected'];
export function checkStatus(status: ArticleStatus): void {
  if (!statuses.includes(status)) throw new Error('Invalid article status');
}
export function articleFrom(note: Note, path: string, files: readonly string[] = [], exclusions: ArticleTemplateExclusions = {}): Article {
  if (!isArticleNote(path, note.doc.toJS({ maxAliasCount: 50 }), exclusions))
    throw new Error('Expected an article note; templates and ordinary notes are preserved');
  let body = note.body, sourceBody = note.body;
  let sectionError: string | undefined;
  try {
    const region = sourceRegion(note);
    if (region.section) {
      const source = displayedSource(region);
      sourceBody = source;
      if (source.trim() || !/(?:```|~~~)[^\n]*\n(?:[^\n]*\n)*?## Article\s*\n/.test(note.body.slice(0, region.start))) body = source;
    }
  } catch (error) { sectionError = String(error); }
  // Every Reader highlight token requires a literal == delimiter. Library scans
  // need highlight metadata, not rendered DOM: avoid rendering every unmarked
  // article (including full feed bodies) just to discover an empty highlight list.
  // Keep the full parser for candidates; HTML/entities/code are not shortcuts.
  const highlights: Highlight[] = body.includes('==')
    ? parseInlineMarkdown(body, { stripTitle: titleOf(note, path) }).highlights : [];
  const content = stringField(note, 'content') as ContentState;
  const templateText = /\{\{[\s\S]*?\}\}|<%[\s\S]*?%>|\$\{[^}]*\}/.test(note.body);
  if (templateText && !sourceBody.trim()) body = note.body;
  const extractor = extractorOf(note, sourceBody);
  const error = sectionError ?? stringField(note, 'error');
  const templateHold = templateText && !error;
  const inferredContent: ContentState = sectionError || error?.startsWith('Snapshot protected:') ||
    (templateHold || sourceBody.trim() && extractor === 'manual') ? 'protected' :
    !sourceBody.trim() && error ? 'error' : sourceBody.trim() ? (extractor === 'summary' ? 'partial' : 'ready') : 'pending';
  return {
    path, title: titleOf(note, path), url: stringField(note, 'url') ?? '',
    feed: stringField(note, 'feed'), published: stringField(note, 'published'), error,
    status: statusFromPath(path), content: inferredContent === 'protected' || content === 'protected' ? 'protected' :
      inferredContent === 'error' || !states.includes(content) ? inferredContent : content,
    extractor, summary: stringField(note, 'summary'), retryAfter: stringField(note, 'retryAfter'),
    readingPosition: readingPosition(note.doc.toJS({ maxAliasCount: 50 }).reading_position),
    topics: readTopics(note, path, files), authors: readTopics(note, path, files, 'authors'),
    relationshipRevisions: { topics: relationshipRevision(note, 'topics', path, files), authors: relationshipRevision(note, 'authors', path, files) }, body, highlights,
  };
}

export function feedFrom(note: Note, path: string): Feed {
  expectType(note, 'feed');
  return {
    path, id: stringField(note, 'id') ?? '', title: titleOf(note, path), url: stringField(note, 'url') ?? '',
    prefix: stringField(note, 'prefix')?.trim() || titleOf(note, path).trim() || 'Feed',
    enabled: note.doc.get('enabled') !== false, checked: stringField(note, 'checked'), etag: stringField(note, 'etag'),
    modified: stringField(note, 'modified'), error: stringField(note, 'error'),
  };
}
