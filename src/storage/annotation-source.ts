import { titleOf, type Note } from './markdown';
import { displayedSource, sourceRegion } from './source';
import { fingerprint } from './fingerprint';

/** Use exactly the source text Reader displays; never mutate Comments/excerpts. */
export function annotationSource(note: Note, path: string) {
  const region = sourceRegion(note), markdown = displayedSource(region);
  const leading = region.section ? /^(?:\r?\n)/.exec(region.text)?.[0].length ?? 0 : 0;
  const start = region.start + leading;
  if (note.body.slice(start, start + markdown.length) !== markdown) throw new Error('Article source boundary is ambiguous');
  return { markdown, start, end: start + markdown.length, region, options: { stripTitle: titleOf(note, path) } };
}

export function replaceAnnotationSource(note: Note, path: string, next: string): boolean {
  const source = annotationSource(note, path);
  if (next === source.markdown) return false;
  note.body = note.body.slice(0, source.start) + next + note.body.slice(source.end);
  // Annotation writes must not grant extraction ownership, including after unmarking.
  note.doc.delete('retryAfter');
  if (source.region.section) {
    if (!note.doc.has('articleSection')) note.doc.set('articleSection', 'Article');
    // Layout-only stamp keeps publisher H2s and authored footers distinct.
    // Retired extraction properties remain opaque and unchanged.
    const length = source.region.text.length + next.length - source.markdown.length;
    note.doc.set('sourceLayoutLength', length);
    note.doc.set('sourceLayoutHash', fingerprint(note.body.slice(source.region.start, source.region.start + length)));
  }
  return true;
}
