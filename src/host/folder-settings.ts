import { defaultFolders, validateFolders, type ReaderFolders } from '../core/folders';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Only the fresh group is active; old root/flat settings remain inert. */
export function loadFolders(data: unknown): ReaderFolders {
  const folders = record(data).folders;
  return folders === undefined ? defaultFolders : validateFolders(folders);
}

/** Preserve unknown data without adopting it as configuration. */
export function saveFolderSettings(data: unknown, candidate: unknown): Record<string, unknown> {
  const folders = validateFolders(candidate);
  const previous = record(data);
  return { ...previous, folders: { ...record(previous.folders), ...folders } };
}
