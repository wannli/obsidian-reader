import type { FileStore } from '../types';

// Request lifetimes only: never queue authority or persisted acquisition work.
const stores = new WeakMap<FileStore, Map<string, number>>();
export function pathGeneration(store: FileStore, path: string): number { return stores.get(store)?.get(path) ?? 0; }
/** Capture before queueing, even when filename selection requires later reads. */
export function capturePathGenerations(store: FileStore): (path: string) => number {
  const versions = new Map(stores.get(store));
  return path => versions.get(path) ?? 0;
}
export function invalidatePaths(store: FileStore, ...paths: string[]): void {
  let versions = stores.get(store);
  if (!versions) { versions = new Map(); stores.set(store, versions); }
  for (const path of paths) versions.set(path, (versions.get(path) ?? 0) + 1);
}
