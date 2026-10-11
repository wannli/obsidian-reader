import type { FileStore } from '../types';
import type { StorageContext } from './context';
import { quoteBlocks } from './blocks';
import { hasReceipt } from './legacy-receipt';
import { assertNoLegacyOwnership } from './legacy-discovery';
import { parseNote, type Note } from './markdown';
import { sidecarPath } from './sidecar-format';

/** Retained as the current inline-storage marker; it is never added by startup. */
export const INLINE_FORMAT = 'inline-v1';
export class LegacyStorageError extends Error {
  constructor(path: string, detail: string) {
    super('Storage action blocked for ' + path + ': ' + detail + '. Pullman did not change or delete the note or legacy data; review and resolve it manually.');
    this.name = 'LegacyStorageError';
  }
}
const candidates = (path: string) => [sidecarPath(path), sidecarPath(path).replace('Reading/Metadata/', 'Reading/Pullman Metadata/')];

/** JSON sidecars are ownership evidence, never automatic migration input. */
export async function assertNoLegacySidecar(store: FileStore, path: string): Promise<void> {
  try {
    for (const legacy of candidates(path)) if (await store.exists(legacy))
      throw new LegacyStorageError(path, 'legacy JSON exists in a historical metadata folder');
    await assertNoLegacyOwnership(store, path);
  } catch (error) {
    if (error instanceof LegacyStorageError) throw error;
    throw new LegacyStorageError(path, error instanceof Error ? error.message : String(error));
  }
}
/** Refuse unsupported records before any plugin-managed write. */
export function assertInlineNote(note: Note, path: string): void {
  if (hasReceipt(note)) throw new LegacyStorageError(path, 'a legacy conversion receipt is present and will not be cleaned up automatically');
  if (note.doc.has('queueMove')) throw new LegacyStorageError(path, 'pending legacy queueMove work requires manual review');
  if (note.doc.has('highlights')) throw new LegacyStorageError(path, 'a legacy highlight array requires manual review');
  if (note.doc.has('pullmanFormat') && note.doc.get('pullmanFormat') !== INLINE_FORMAT)
    throw new LegacyStorageError(path, 'unknown pullmanFormat marker');
  // An inline-v1 marker can identify inert historical excerpts retained for
  // existing backlinks. Unmarked quote blocks have no verified ownership.
  if (!note.doc.has('pullmanFormat') && quoteBlocks(note.body).size)
    throw new LegacyStorageError(path, 'recognizable unconverted quote blocks require manual review; existing backlinks are being preserved');
}

export interface ConversionReport { converted: number; errors: string[]; warnings: string[]; }
/** Read-only inventory. The historical API name is retained for callers. */
export async function prepareInlineStorage(context: StorageContext): Promise<ConversionReport> {
  context.assertActive();
  const report: ConversionReport = { converted: 0, errors: [], warnings: [] };
  context.resetLegacyBlocks();
  const paths = await context.store.list();
  report.errors.push(...await context.refreshLegacyBlocks(paths));
  for (const path of paths) {
    if (!/\.md$/i.test(path) || context.isTemplate(path) || context.hasLegacyBlock(path)) continue;
    try {
      const note = parseNote(await context.store.read(path));
      if (!context.isArticle(note, path) && note.doc.get('type') !== 'feed') continue;
      assertInlineNote(note, path);
      await assertNoLegacySidecar(context.store, path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof LegacyStorageError) context.blockLegacy(path, detail);
      report.errors.push(path + ': ' + detail);
    }
  }
  return report;
}
