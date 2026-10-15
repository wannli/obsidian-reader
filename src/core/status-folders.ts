import { folderPath } from './folders';
import { articleStatuses, type ArticleStatus } from './model';

/** Absent is unmapped; an explicit empty path maps to the vault root. */
export type StatusFolders = Readonly<Partial<Record<ArticleStatus, string>>>;

export function validateStatusFolders(input: unknown): StatusFolders {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Choose valid status folder mappings.');
  const record = input as Record<string, unknown>;
  const result: Partial<Record<ArticleStatus, string>> = {};
  for (const status of articleStatuses)
    if (Object.hasOwn(record, status)) result[status] = folderPath(record[status]);
  return Object.freeze(result);
}

export function loadStatusFolders(data: unknown): StatusFolders {
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
