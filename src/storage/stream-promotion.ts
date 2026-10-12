import type { Article } from '../types';
import { statusFromPath } from '../reading-layout';
import type { StorageContext } from './context';
import { parseNote } from './markdown';
import { moveArticle } from './moves';
import { pathGeneration } from './path-generation';

/** Publisher links/full text are not proof of authored annotation. */
export function hasStreamAnnotation(article: Article): boolean {
  return !!(article.highlights.length || article.topics?.length || article.authors?.length);
}

/** Called after debounced native save/editor/layout events. Open Markdown editors
 * are deliberately deferred by the ordinary mover; a later layout/save retries.
 * No polling writes, sidecars, or guesses about bare manually authored links. */
export async function promoteAnnotatedStream(context: StorageContext, busy: (path: string) => boolean = () => false): Promise<{ promoted: string[]; retained: string[] }> {
  const result = { promoted: [] as string[], retained: [] as string[] };
  for (const path of (await context.store.list()).filter(path => statusFromPath(path) === 'feed')) {
    try {
      const generation = pathGeneration(context.store, path), revision = await context.assertWritable(path);
      const raw = await context.store.read(path), note = parseNote(raw);
      if (!context.isArticle(note, path) || !hasStreamAnnotation(context.article(note, path))) continue;
      if (busy(path)) { result.retained.push(path); continue; }
      const moved = await moveArticle(context, path, 'inbox', { expectedGeneration: generation, expectedRevision: raw, expectedStorageRevision: revision,
        guard: () => { if (busy(path) || !context.isArticle(note, path)) throw new Error('Article eligibility changed'); } });
      result.promoted.push(moved.path);
    } catch { result.retained.push(path); }
  }
  return result;
}
