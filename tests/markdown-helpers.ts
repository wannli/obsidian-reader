import type { ReaderRepository } from '../src/storage/repository';
import type { FileStore } from '../src/types';
import { parseNote } from '../src/storage/markdown';
export async function noteMetadata(store: FileStore, path: string) { return parseNote(await store.read(path)).doc.toJS(); }
export const readNoteRaw = (store: FileStore, path: string) => store.read(path);
export const rawStore = (store: FileStore) => store;
export const rawSnapshot = (snapshot: Record<string, string>, path: string) => snapshot[path];
/** Whole inventory: do not conceal accidental JSON writes. */
export const allFilesSnapshot = (snapshot: Record<string, string>) => snapshot;
import type { HighlightInput } from '../src/storage/highlights';
import { parseInlineMarkdown } from '../src/inline';
/** Select real current source, retaining explicitly supplied stale revisions/anchors. */
export async function mark(repo: ReaderRepository, path: string, input: HighlightInput) {
  const article = await repo.getArticle(path);
  const parsed = parseInlineMarkdown(article.body, { stripTitle: article.title });
  return repo.addHighlight(path, { revision: parsed.revision, ...input });
}
/** Exact occurrence in rendered canonical text, with code-point rather than UTF-16 offsets. */
export async function selection(repo: ReaderRepository, path: string, quote: string, occurrence = 0) {
  const article = await repo.getArticle(path);
  const parsed = parseInlineMarkdown(article.body, { stripTitle: article.title });
  let index = -1;
  for (let n = 0; n <= occurrence; n++) {
    index = parsed.canonicalText.indexOf(quote, index + 1);
    if (index < 0) throw new Error('Fixture selection is absent from current article: ' + quote);
  }
  const start = Array.from(parsed.canonicalText.slice(0, index)).length;
  return { quote, anchor: { start, end: start + Array.from(quote).length, prefix: '', suffix: '', version: parsed.revision } };
}
