import type { NoteFile } from '../store';
import type { ThinkingDocument, ThinkingRecord, ThinkingTarget } from './types';

export interface ThinkingProjectedEntry {
  record: ThinkingRecord;
  explorations: string[];
  /** Reverse display only: explicit owners/labels, never persisted inverse edges. */
  incoming: { owner: ThinkingTarget; label?: string }[];
}
export interface ThinkingReadProjection {
  entries: ThinkingProjectedEntry[];
  unassigned: ThinkingProjectedEntry[];
  dates: string[];
  complete: boolean;
}
/** One read-only snapshot for reading, saved material and overview. Documents are host-
 * approved containers; ordinary links elsewhere do not assert entry-owned connections.
 * Dates are saved collection dates only; no file timestamps or activity inference. */
export function projectThinking<File extends NoteFile>(
  documents: readonly ThinkingDocument<File>[],
  options: {
    complete?: boolean;
    resolve?: (target: ThinkingTarget, sourcePath: string) => string | undefined;
  } = {},
): ThinkingReadProjection {
  const normalize = (path: string) => path.replace(/\.md$/i, '');
  const resolve = (target: ThinkingTarget, source: string) =>
    options.resolve ? options.resolve(target, source) : normalize(target.path);
  const entries = documents.flatMap((document) =>
    document.records.map((record) => ({
      record,
      explorations: [] as string[],
      incoming: [] as ThinkingProjectedEntry['incoming'],
    })),
  );
  for (const entry of entries) {
    const targetPath = options.resolve
      ? options.resolve({ path: entry.record.path }, entry.record.path)
      : normalize(entry.record.path);
    if (targetPath === undefined) continue;
    for (const document of documents) {
      if (
        document.memberships.some(
          (item) =>
            item.target.blockId === entry.record.blockId &&
            resolve(item.target, document.path) === targetPath,
        )
      )
        entry.explorations.push(document.path);
      for (const record of document.records) {
        for (const connection of record.connections) {
          if (
            connection.target.blockId === entry.record.blockId &&
            resolve(connection.target, document.path) === targetPath
          )
            entry.incoming.push({
              owner: { path: record.path, blockId: record.blockId },
              ...(connection.label ? { label: connection.label } : {}),
            });
        }
      }
    }
  }
  return {
    entries,
    unassigned: entries.filter((entry) => !entry.explorations.length),
    dates: [...new Set(entries.map((entry) => entry.record.collected))].sort().reverse(),
    complete: options.complete === true && documents.every((document) => !document.issues.length),
  };
}
