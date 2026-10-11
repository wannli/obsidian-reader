import type { FileStore } from '../src/types';
import { parseNote } from '../src/storage/markdown';
import { fingerprint } from '../src/storage/fingerprint';
import { safePath } from '../src/storage/safety';

/** Test-only path builder for historical JSON ownership-evidence fixtures. */
export const sidecarPath = (path: string): string => 'Reading/Metadata/' + fingerprint(safePath(path, true)) + '.json';

/** Transitional test names only: every assertion inspects actual Markdown/YAML. */
export async function sidecarMetadata(store: FileStore, path: string) {
  return parseNote(await store.read(path)).doc.toJS();
}
export function hydratedStoreRaw(store: FileStore, path: string): Promise<string> {
  return store.read(path);
}
export function virtualStore(store: FileStore): FileStore { return store; }
export function hydratedSnapshot(snapshot: Record<string, string>, path: string): string {
  return snapshot[path];
}
/** Do not filter JSON away: accidental active sidecars must fail snapshot assertions. */
export const markdownSnapshot = (snapshot: Record<string, string>) => snapshot;
