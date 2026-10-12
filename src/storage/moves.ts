import type { Article, ArticleStatus } from '../types';
import { queueFolder, statusFromPath } from '../reading-layout';
import { StorageContext } from './context';
import { parseNote } from './markdown';
import { assertMoveLinks } from './move-links';
import { invalidatePaths, pathGeneration } from './path-generation';
import { StaleArticleWriteError } from './preconditions';
import { safePath } from './safety';

/** Exact rename only after proving ordinary links keep their targets.
 * No JSON metadata sidecar, journal copy, or repair journal is written. */
export interface MoveExpectation { expectedGeneration?: number; expectedRevision?: string; expectedStorageRevision?: number; guard?: () => void; }
export async function moveArticle(context: StorageContext, from: string, status: ArticleStatus, expected: MoveExpectation = {}): Promise<Article> {
  safePath(from, true);
  let generation = expected.expectedGeneration ?? pathGeneration(context.store, from);
  const assertCurrent = () => {
    if (pathGeneration(context.store, from) !== generation) throw new StaleArticleWriteError();
    if (expected.expectedStorageRevision !== undefined) context.assertRevision(from, expected.expectedStorageRevision);
    expected.guard?.();
  };
  assertCurrent();
  const fromRevision = await context.assertWritable(from);
  const raw = await context.store.read(from), note = parseNote(raw);
  assertCurrent();
  if (expected.expectedRevision !== undefined && raw !== expected.expectedRevision) throw new StaleArticleWriteError();
  const article = context.article(note, from);
  if (statusFromPath(from) === status) return article;
  const to = queueFolder(status) + '/' + from.split('/').pop()!;
  safePath(to, true);
  const toRevision = await context.assertWritable(to);
  const paths = await context.store.list(), folded = (value: string) => value.normalize('NFC').toLowerCase();
  if (await context.store.exists(to) || paths.some(path => path !== from && folded(path) === folded(to)))
    throw new Error('Queue destination already exists; preserved both articles');
  // vault.rename does not perform native link repair. Conservatively refuse
  // affected explicit/relative references, including historical journal links.
  await assertMoveLinks(context.store, from, to, raw, paths);
  assertCurrent();
  invalidatePaths(context.store, from, to);
  generation = pathGeneration(context.store, from); // Account only for our own synchronous invalidation.
  await context.store.rename(from, to, { expectedContent: raw, guard: () => {
    assertCurrent();
    context.assertRevision(from, fromRevision); context.assertRevision(to, toRevision);
    context.assertWritableNow(from); context.assertWritableNow(to);
  } });
  return context.article(await context.read(to), to, await context.store.list());
}
