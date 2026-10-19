import { folderPath } from './folders';
import { articleStatuses, type ArticleStatus, type Queue, queues } from './model';

export type StatusFolders = Readonly<Partial<Record<ArticleStatus, string>>>;
export type ResolvedStatusFolders = Readonly<Record<ArticleStatus, string>>;

export const defaultStatusFolders: ResolvedStatusFolders = Object.freeze({
  inbox: 'Reading/Inbox',
  feed: 'Reading/Stream',
  later: 'Reading/Later',
  archive: 'Reading/Treasury',
});

/** Folder membership is the queue; overlapping or root destinations are ambiguous. */
export function validateStatusFolders(input: unknown): ResolvedStatusFolders {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Choose valid status folder mappings.');
  const record = input as Record<string, unknown>;
  const result = { ...defaultStatusFolders };
  for (const status of articleStatuses)
    if (Object.hasOwn(record, status)) result[status] = folderPath(record[status]);
  for (const [index, status] of articleStatuses.entries()) {
    const path = result[status];
    if (!path || path.split('/').some((part) => /^(?:templates|\.trash)$/i.test(part)))
      throw new Error(
        'Queue folders must be outside Templates and .trash and cannot be vault root.',
      );
    for (const other of articleStatuses.slice(index + 1)) {
      const a = path.normalize('NFC').toLowerCase();
      const b = result[other].normalize('NFC').toLowerCase();
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
        throw new Error('Queue folders must not overlap.');
    }
  }
  return Object.freeze(result);
}

export function queueForPath(path: string, folders: ResolvedStatusFolders): Queue | undefined {
  const normalized = path.normalize('NFC').toLowerCase();
  const status = articleStatuses.find((value) =>
    normalized.startsWith(`${folders[value].normalize('NFC').toLowerCase()}/`),
  );
  return status === undefined ? undefined : queues[articleStatuses.indexOf(status)];
}

export function loadStatusFolders(data: unknown): ResolvedStatusFolders {
  const value =
    data && typeof data === 'object' ? (data as Record<string, unknown>).statusFolders : undefined;
  return validateStatusFolders(value === undefined ? {} : value);
}

export function saveStatusFolderSettings(
  data: unknown,
  candidate: unknown,
): Record<string, unknown> {
  const folders = validateStatusFolders(candidate);
  const previous =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const old = previous.statusFolders;
  const unknown =
    old && typeof old === 'object' && !Array.isArray(old)
      ? ({ ...old } as Record<string, unknown>)
      : {};
  for (const status of articleStatuses) delete unknown[status];
  return { ...previous, statusFolders: { ...unknown, ...folders } };
}
