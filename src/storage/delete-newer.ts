import type { StorageContext } from './context';
import { disposableStreamNote } from './stream-disposal';
import { parseNote } from './markdown';
import { statusFromPath } from '../reading-layout';
import { referencesArticle } from './move-links';
import { invalidatePaths, pathGeneration } from './path-generation';

export interface StreamTrashCandidate { path: string; generation: number; raw: string; }
async function eligible(context: StorageContext, candidate: StreamTrashCandidate): Promise<boolean> {
  const { path, generation, raw } = candidate;
  if (statusFromPath(path) !== 'feed' || pathGeneration(context.store, path) !== generation || !await context.store.exists(path)) return false;
  if (await context.store.read(path) !== raw) return false;
  const note = parseNote(raw);
  if (!context.isArticle(note, path)) return false;
  const article = context.article(note, path);
  if (!disposableStreamNote(note, article)) return false;
  const paths = await context.store.list();
  for (const other of paths) {
    if (other === path) continue;
    let referenced = false;
    const check = (text: string) => { referenced = referencesArticle(text, other, path, paths); };
    if (context.store.inspect) await context.store.inspect(other, check);
    else check(await context.store.read(other));
    if (referenced) return false;
  }
  return true;
}
export async function previewStreamTrash(context: StorageContext, candidates: StreamTrashCandidate[]) {
  const eligibleCandidates: StreamTrashCandidate[] = [];
  for (const candidate of candidates) if (await eligible(context, candidate)) eligibleCandidates.push(candidate);
  return { candidates: eligibleCandidates, skipped: candidates.length - eligibleCandidates.length };
}
export async function trashStreamCandidate(context: StorageContext, candidate: StreamTrashCandidate, guard: () => void): Promise<boolean> {
  guard();
  const revision = await context.assertWritable(candidate.path);
  if (!await eligible(context, candidate)) return false;
  if (!context.store.trash) throw new Error('Recoverable trash is unavailable.');
  await context.store.trash(candidate.path, { expectedContent: candidate.raw, guard: () => {
    guard(); context.assertWritableNow(candidate.path); context.assertRevision(candidate.path, revision);
    if (pathGeneration(context.store, candidate.path) !== candidate.generation) throw new Error('Article identity changed.');
  } });
  invalidatePaths(context.store, candidate.path);
  return true;
}
