import { expiredStreamItem } from '../stream-age';
import { statusFromPath } from '../reading-layout';
import { invalidatePaths, pathGeneration } from './path-generation';
import { parseNote, stringField } from './markdown';
import type { StorageContext } from './context';
import { referencesArticle } from './move-links';
import { moveArticle } from './moves';
import { hasStreamAnnotation } from './stream-promotion';

// Unknown metadata and all text outside a provably owned flat snapshot survive.
const disposableFields = new Set(['type', 'title', 'url', 'feed', 'published', 'fetched', 'summary', 'error', 'retryAfter']);
export async function cleanupStream(context: StorageContext, cutoff: number, busy: (path: string) => boolean = () => false): Promise<{ deleted: string[]; retained: string[] }> {
  const result = { deleted: [] as string[], retained: [] as string[] };
  let paths = await context.store.list();
  for (const path of paths.filter(path => statusFromPath(path) === 'feed')) {
    try {
      const generation = pathGeneration(context.store, path);
      const revision = await context.assertWritable(path);
      const raw = await context.store.read(path), note = parseNote(raw);
      if (!context.isArticle(note, path) || !expiredStreamItem(stringField(note, 'published'), stringField(note, 'fetched'), cutoff)) continue;
      if (busy(path)) { result.retained.push(path); continue; }
      const article = context.article(note, path);
      // Authored annotation evidence, not arbitrary publisher links/full text.
      // A refused safe move falls through the catch into retained, never trash.
      if (hasStreamAnnotation(article)) {
        await moveArticle(context, path, 'inbox', { expectedGeneration: generation, expectedRevision: raw, expectedStorageRevision: revision,
          guard: () => { if (busy(path) || !context.isArticle(note, path)) throw new Error('Article eligibility changed'); } });
        paths = await context.store.list();
        continue;
      }
      const properties = note.doc.toJS({ maxAliasCount: 50 });
      if (article.content === 'protected' || article.highlights.length || article.extractor === 'manual' ||
          Object.keys(properties).some(key => !disposableFields.has(key)) || /(^|\s)#/.test(note.header) ||
          note.body.trim() !== article.body.trim() || !context.store.trash) {
        result.retained.push(path); continue;
      }
      // Never strand authored references/journals.
      let referenced = false;
      for (const other of paths) {
        if (other === path || result.deleted.includes(other)) continue;
        const check = (text: string) => { if (referencesArticle(text, other, path, paths)) referenced = true; };
        if (context.store.inspect) await context.store.inspect(other, check);
        else check(await context.store.read(other));
        if (referenced) break;
      }
      if (referenced) { result.retained.push(path); continue; }
      await context.store.trash(path, { expectedContent: raw, guard: () => {
        context.assertWritableNow(path); context.assertRevision(path, revision);
        if (busy(path) || pathGeneration(context.store, path) !== generation || !context.isArticle(note, path)) throw new Error('Article eligibility changed');
      } });
      invalidatePaths(context.store, path);
      result.deleted.push(path);
    } catch { result.retained.push(path); }
  }
  return result;
}
