import type { Article, ArticleStatus } from '../types';
import { queueFolder, statusFromPath } from '../reading-layout';
import { StorageContext } from './context';
import { parseNote, stringField } from './markdown';
import { assertMoveLinks } from './move-links';
import { assertInlineNote } from './legacy-import';
import { invalidatePaths } from './path-generation';
import { safePath } from './safety';

/** Exact rename only after proving ordinary links keep their targets.
 * No JSON metadata sidecar, journal copy, or repair journal is written. */
export async function moveArticle(context: StorageContext, from: string, status: ArticleStatus): Promise<Article> {
  safePath(from, true);
  const fromRevision = await context.assertWritable(from);
  const raw = await context.store.read(from), note = parseNote(raw);
  assertInlineNote(note, from);
  const article = context.article(note, from);
  if (statusFromPath(from) === status) return article;
  const to = queueFolder(status) + '/' + from.split('/').pop()!;
  safePath(to, true);
  const toRevision = await context.assertWritable(to);
  if (article.id && (await context.scan()).some(item => item.path !== from && stringField(item.note, 'id') === article.id))
    throw new Error('Duplicate article ID; queue move deferred');
  const paths = await context.store.list(), folded = (value: string) => value.normalize('NFC').toLowerCase();
  if (await context.store.exists(to) || paths.some(path => path !== from && folded(path) === folded(to)))
    throw new Error('Queue destination already exists; preserved both articles');
  // vault.rename does not perform native link repair. Conservatively refuse
  // affected explicit/relative references, including historical journal links.
  await assertMoveLinks(context.store, from, to, raw, paths);
  invalidatePaths(context.store, from, to);
  await context.store.rename(from, to, { expectedContent: raw, guard: () => {
    context.assertOwnershipRevision(from, fromRevision); context.assertOwnershipRevision(to, toRevision);
    context.assertWritableNow(from); context.assertWritableNow(to);
  } });
  return context.article(await context.read(to), to, await context.store.list());
}
