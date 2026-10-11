import type { ArticleExtractor, ExtractedArticle } from '../types';
import { isAcquisitionUrl } from '../acquisition-url';
import { fingerprint } from './fingerprint';
import { dummyArticle } from '../ingest/dummy';
import { stringField, type Note } from './markdown';
import { gap, headings } from './sections';
import type { AcquisitionWriteOptions } from './preconditions';
import { parseInlineMarkdown } from '../inline';

const extractors: ArticleExtractor[] = ['pending', 'summary', 'manual', 'dummy', 'defuddle', 'feed'];
export interface SourceRegion { start: number; end: number; text: string; section: boolean; ownedLength?: number; }
export interface SaveContentOptions extends AcquisitionWriteOptions { allowFeedReplacement?: boolean; }
export function sourceRegion(note: Note): SourceRegion {
  const all = headings(note.body);
  const flatLength = note.doc.get('sourceLength'), flatHash = note.doc.get('sourceHash');
  if (!note.doc.has('articleSection') && typeof flatLength === 'number' && Number.isSafeInteger(flatLength) && flatLength > 0 &&
      flatLength <= note.body.length && typeof flatHash === 'string' && fingerprint(note.body.slice(0, flatLength)) === flatHash)
    return { start: 0, end: note.body.length, text: note.body, section: false };
  // An ordinary Article template needs no Comments footer. A stamped flat
  // publisher snapshot above wins over headings that happen to use this name.
  const articleHeadings = all.filter(heading => heading.level === 2 && heading.title === 'Article');
  const sectionStamp = articleHeadings.some(heading => typeof flatLength === 'number' && Number.isSafeInteger(flatLength) && flatLength >= 0 &&
    typeof flatHash === 'string' && fingerprint(note.body.slice(heading.end, heading.end + flatLength)) === flatHash);
  // A changed flat source must not suddenly become a template merely because
  // its publisher uses Article headings. Unknown ownership remains protected.
  if (!note.doc.has('articleSection') && (flatLength !== undefined || flatHash !== undefined) && !sectionStamp)
    return { start: 0, end: note.body.length, text: note.body, section: false };
  // Only a unique empty capture slot or a verified stamp identifies a section.
  const firstArticle = articleHeadings[0];
  const following = firstArticle && all.find(next => next.start > firstArticle.start && next.level <= 2);
  const emptySlot = articleHeadings.length === 1 && !all.some(item => item.start < firstArticle.start && item.level === 1) &&
    !note.body.slice(firstArticle.end, following?.start ?? note.body.length).trim() &&
    (!following || (following.level === 2 && ['Comments', 'Highlights'].includes(following.title)));
  const implicit = articleHeadings.length === 1 && (sectionStamp || emptySlot ||
    !note.body.slice(0, firstArticle.start).trim());
  const name = note.doc.get('articleSection') ?? (implicit ? 'Article' : undefined);
  if (name === undefined) return { start: 0, end: note.body.length, text: note.body, section: false };
  if (typeof name !== 'string' || !name.trim() || /[\r\n]/.test(name)) throw new Error('Invalid article section name');
  const matching = all.filter(heading => heading.level === 2 && heading.title === name);
  // Annotation layout is not extraction ownership. It is used only to locate
  // protected section boundaries after inline syntax changed the source hash.
  const layout = note.doc.has('sourceLayoutHash') && note.doc.has('sourceLayoutLength');
  const length = note.doc.get(layout ? 'sourceLayoutLength' : 'sourceLength');
  const hash = note.doc.get(layout ? 'sourceLayoutHash' : 'sourceHash');
  const validPrefix = (start: number) => typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 &&
    start + length <= note.body.length && typeof hash === 'string' && fingerprint(note.body.slice(start, start + length)) === hash;
  const owned = matching.filter(heading => validPrefix(heading.end));
  const comments = all.filter(item => item.level === 2 && item.title === 'Comments');
  const nestedPublisher = note.doc.get('articleSection') === 'Article' && matching.length > 1 &&
    all[0] === matching[0] && comments.length >= 2 && comments[comments.length - 1].start > matching[matching.length - 1].start;
  if (owned.length !== 1 && matching.length !== 1 && !nestedPublisher) throw new Error('The designated Article section is missing or ambiguous');
  const heading = owned.length === 1 ? owned[0] : matching[0];
  const ownedLength = validPrefix(heading.end) ? length as number : undefined;
  const afterSource = heading.end + (ownedLength ?? 0);
  // Native Article text may have no ownership stamp yet. Its publisher H2s
  // are source, not note boundaries; only reserved footers end that region.
  // A verified stamp or explicitly named custom section retains its precise
  // surrounding-section contract, including arbitrary authored tail headings.
  const boundedComments = note.doc.get('articleSection') === 'Article' && ownedLength === undefined &&
    all[0] === heading && comments.length > 0 && comments[comments.length - 1].start > heading.start;
  const end = boundedComments ? comments[comments.length - 1].start :
    note.doc.get('articleSection') === 'Article' && ownedLength === undefined && all[0] === heading && !comments.length
      ? note.body.length :
    all.find(next => next.start >= afterSource && next.start > heading.start && next.level <= 2 &&
      (ownedLength !== undefined || name !== 'Article' ||
        (next.level === 2 && ['Comments', 'Highlights'].includes(next.title))))?.start ?? note.body.length;
  return { start: heading.end, end, text: note.body.slice(heading.end, end), section: true, ownedLength };
}
export function displayedSource(region: SourceRegion): string {
  const text = region.ownedLength !== undefined && !region.text.slice(region.ownedLength).trim() ? region.text.slice(0, region.ownedLength) : region.text;
  return region.section ? text.replace(/^\r?\n/, '').replace(/\r?\n\r?\n$/, '') : text;
}
export function extractorOf(note: Note, body: string): ArticleExtractor {
  const explicit = stringField(note, 'extractor') as ArticleExtractor;
  if (extractors.includes(explicit)) {
    const length = note.doc.get('sourceLength'), hash = note.doc.get('sourceHash');
    let stamped = false;
    try {
      const text = sourceRegion(note).text;
      stamped = typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 &&
        length <= text.length && typeof hash === 'string' && fingerprint(text.slice(0, length)) === hash;
    } catch { /* Unknown layout cannot establish ownership. */ }
    if (!body.trim() || stamped) return explicit;
  }
  const summary = stringField(note, 'summary');
  if (!body.trim()) return summary?.trim() ? 'summary' : 'pending';
  if (summary?.trim() && body.trim() === summary.trim()) return 'summary';
  const url = stringField(note, 'url');
  if (url && isAcquisitionUrl(url) && body.trim() === dummyArticle(url).markdown.trim()) return 'dummy';
  return 'manual';
}
export function stampSource(_note: Note, extractor: ArticleExtractor, _text: string): void {
  if (!extractors.includes(extractor)) throw new Error('Invalid article extractor');
  // Historical stamps remain readable until migration, but no new stamps are written.
}
function protectedSnapshot(note: Note, reason: string): boolean {
  note.doc.set('error', 'Snapshot protected: ' + reason + ' Explicit refresh is required.');
  note.doc.delete('retryAfter');
  return true;
}
function ownedLength(note: Note, region: SourceRegion, extractor: ArticleExtractor): number | undefined {
  const length = note.doc.get('sourceLength'), hash = note.doc.get('sourceHash');
  if (length !== undefined || hash !== undefined) {
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > region.text.length || typeof hash !== 'string') return undefined;
    const prefix = region.text.slice(0, length);
    if (!prefix.trim() && region.text.trim()) return undefined;
    return fingerprint(prefix) === hash ? length : undefined;
  }
  if (!region.text.trim()) return region.text.length;
  const summary = stringField(note, 'summary');
  // Only an exact excerpt match grants ownership without a historical stamp.
  if (extractor === 'summary' && summary && region.text.trim() === summary.trim()) return region.text.length;
  const url = stringField(note, 'url');
  if (extractor === 'dummy' && url && isAcquisitionUrl(url)) {
    const bare = dummyArticle(url).markdown;
    if (region.section ? region.text === '\n' + bare + '\n\n' : region.text === bare || region.text === bare + gap(bare)) return region.text.length;
  }
  return undefined;
}

export function saveExtractedSource(note: Note, result: ExtractedArticle, highlightCount: number, options: SaveContentOptions = {}): boolean {
  // Veto using the latest note from the mutation, not the pre-extraction snapshot.
  if (note.doc.get('content') === 'protected') return false;
  let region: SourceRegion;
  try { region = sourceRegion(note); } catch (error) { return protectedSnapshot(note, String(error)); }
  if (/\{\{[\s\S]*?\}\}|<%[\s\S]*?%>|\$\{[^}]*\}/.test(region.text)) return protectedSnapshot(note, 'unexpanded source template text is never replaced.');
  const extractor = extractorOf(note, displayedSource(region)), next = result.extractor;
  if (extractor === 'defuddle') return false;
  if (extractor === 'feed' && (options.allowFeedReplacement !== true || next !== 'defuddle' || !isAcquisitionUrl(note.doc.get('url')))) return false;
  if (next === 'dummy' && (extractor === 'summary' || stringField(note, 'summary')?.trim())) return false;
  if (!['defuddle', 'dummy'].includes(next) || !['ready', 'partial'].includes(result.status) || !result.markdown.trim()) throw new Error('Invalid or empty extracted article');
  const annotations = parseInlineMarkdown(displayedSource(region));
  if (highlightCount || annotations.highlights.length || annotations.hasUnsupportedHighlights)
    return protectedSnapshot(note, 'this source has highlights, including any unsupported authored marks.');
  if (extractor === 'manual') return protectedSnapshot(note, 'authored or unknown source text is never replaced automatically.');
  const length = ownedLength(note, region, extractor);
  if (length === undefined) return protectedSnapshot(note, 'the tracked source was edited or its ownership is unknown.');
  if (extractor === 'dummy' && next === 'dummy') return false;
  const suffix = region.text.slice(length);
  const replacement = region.section ? '\n' + result.markdown + '\n\n' : result.markdown + (suffix ? gap(result.markdown) : '');
  note.body = note.body.slice(0, region.start) + replacement + suffix + note.body.slice(region.end);
  stampSource(note, next, replacement);
  if (region.section && !note.doc.has('articleSection')) note.doc.set('articleSection', 'Article');
  // Retain publisher titles without overwriting a title authored in the latest note.
  if (next === 'defuddle' && !stringField(note, 'title')?.trim() && result.title.trim())
    note.doc.set('title', result.title.trim());
  if (result.warning) note.doc.set('error', result.warning); else note.doc.delete('error');
  note.doc.delete('retryAfter');
  return true;
}
