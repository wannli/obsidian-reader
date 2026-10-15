export const folderKeys = ['articles', 'feeds'] as const;
export type FolderKey = (typeof folderKeys)[number];
export type ReaderFolders = Readonly<Record<FolderKey, string>>;

export const defaultFolders: ReaderFolders = Object.freeze({
  articles: 'Reading/Articles',
  feeds: 'Reading/Feeds',
});

export const folderLabels: Readonly<Record<FolderKey, string>> = {
  articles: 'Articles',
  feeds: 'Feed subscriptions',
};

/** Do not normalize unsafe input into a different destination. */
export function folderPath(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Choose a vault-relative folder.');
  if (input === '') return ''; // Explicit vault-root destination.
  const encoder = new TextEncoder();
  if (
    /[\\:*?"<>|\[\]#^\x00-\x1f\x7f]/.test(input) ||
    input
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part !== part.trim() ||
          part.endsWith('.') ||
          /^\.(?:obsidian|trash)$/i.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) ||
          encoder.encode(part).length > 255,
      )
  )
    throw new Error('Choose a portable vault-relative folder without unsafe path segments.');
  return input;
}

/** Validate the whole group before returning any usable destinations. */
export function validateFolders(input: unknown): ReaderFolders {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Choose both Reader capture folders.');
  const record = input as Record<string, unknown>;
  const folders = Object.fromEntries(
    folderKeys.map((key) => [key, folderPath(record[key])]),
  ) as Record<FolderKey, string>;
  return Object.freeze(folders);
}

export function isWithinFolder(path: string, folder: string): boolean {
  return folder === '' || path.startsWith(`${folder}/`);
}
