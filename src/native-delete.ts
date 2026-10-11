interface DeletedEntry { path: string; children?: DeletedEntry[]; }
interface DeleteController {
  articleDeleted(path: string): Promise<void>;
  vaultChanged(): void;
}
/** Folder objects retain their deleted subtree; duplicate child events are harmless. */
export function nativeDeleteHandler(controller: DeleteController, changed: () => void, report: (error: unknown) => void, closing: () => boolean) {
  return (file: DeletedEntry): void => {
    if (closing()) return;
    const paths = new Set<string>();
    const collect = (entry: DeletedEntry) => {
      if (entry.children) entry.children.forEach(collect);
      else if (/\.md$/i.test(entry.path)) paths.add(entry.path);
    };
    collect(file);
    // Start all invalidations before awaiting; don't stop at the first child conflict.
    void Promise.allSettled([...paths].map(path => controller.articleDeleted(path))).then(results => {
      for (const result of results) if (result.status === 'rejected') report(result.reason);
      changed();
    }).catch(report);
  };
}
