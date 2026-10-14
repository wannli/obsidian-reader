export const folderKeys = ['inbox', 'stream', 'later', 'treasury', 'feeds'] as const;
export type FolderKey = (typeof folderKeys)[number];
export type ReaderFolders = Readonly<Record<FolderKey, string>>;

export const defaultFolders: ReaderFolders = Object.freeze({
  inbox: 'Reading/Inbox',
  stream: 'Reading/Stream',
  later: 'Reading/Later',
  treasury: 'Reading/Treasury',
  feeds: 'Reading/Wires',
});

export const folderLabels: Readonly<Record<FolderKey, string>> = {
  inbox: 'Inbox',
  stream: 'Stream',
  later: 'Later',
  treasury: 'Treasury',
  feeds: 'Feed subscriptions',
};

/** Do not normalize unsafe input into a different destination. */
export function folderPath(input: unknown): string {
  if (typeof input !== 'string' || !input)
    throw new Error('Choose a nonempty vault-relative folder.');
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
    throw new Error('Choose all five Reader folders.');
  const record = input as Record<string, unknown>;
  const folders = Object.fromEntries(
    folderKeys.map((key) => [key, folderPath(record[key])]),
  ) as Record<FolderKey, string>;
  const comparable = (path: string) => path.normalize('NFC').toLowerCase();
  for (let i = 0; i < folderKeys.length; i++) {
    for (let j = i + 1; j < folderKeys.length; j++) {
      const left = folderKeys[i],
        right = folderKeys[j],
        a = comparable(folders[left]),
        b = comparable(folders[right]);
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
        throw new Error(`${folderLabels[left]} and ${folderLabels[right]} must not overlap.`);
    }
  }
  return Object.freeze(folders);
}

export function isWithinFolder(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}
