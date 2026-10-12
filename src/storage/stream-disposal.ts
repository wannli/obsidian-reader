import type { Article } from '../types';
import { readingPosition } from '../reading-position';
import { stringField, type Note } from './markdown';
import { headings } from './sections';
import { hasStreamAnnotation } from './stream-promotion';

const disposableFields = new Set(['type', 'title', 'url', 'feed', 'published', 'fetched', 'summary', 'error', 'retryAfter']);
/** User-approved RSS disposal: unmarked edits within a flat RSS body cannot be
 * distinguished from publisher text and may be discarded. Annotation/layout,
 * unknown metadata and incoming references remain protected separately. */
export function disposableStreamNote(note: Note, article: Article): boolean {
  const properties = note.doc.toJS({ maxAliasCount: 50 });
  if (hasStreamAnnotation(article) || Object.keys(properties).some(key => !disposableFields.has(key) &&
      !(key === 'reading_position' && readingPosition(properties[key]))) ||
      /(^|\s)#/.test(note.header) || note.body.trim() !== article.body.trim()) return false;
  // Reserved authored sections and comments protect even flat RSS snapshots.
  if (headings(note.body).some(heading => /^(article|comments|highlights|notes)$/i.test(heading.title)) ||
      /<!--|%%/.test(note.body)) return false;
  const rss = !!stringField(note, 'feed')?.trim();
  if (rss && article.extractor === 'manual') {
    // Do not override explicit protection or ambiguous/template content merely
    // because inferred protection treats arbitrary full RSS prose as manual.
    return stringField(note, 'content') !== 'protected' && !article.error &&
      !/\{\{[\s\S]*?\}\}|<%[\s\S]*?%>|\$\{[^}]*\}/.test(note.body);
  }
  return article.content !== 'protected' && article.extractor !== 'manual';
}
