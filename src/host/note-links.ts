import { parseLinktext, type App } from 'obsidian';

/** Rendered hrefs are encoded once. Never reinterpret a decoded URI as a vault path. */
export function nativeLinkPath(value: string, encoded = true): string | undefined {
  let path: string;
  try {
    path = (encoded ? decodeURIComponent(value) : value).trim();
  } catch {
    return;
  }
  if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(path)) return;
  path = path.replace(/^\//, '');
  return path && !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(path) ? path : undefined;
}

/** Unlike openLinkText, this never asks Obsidian to create a missing note. */
export async function openExistingNote(
  app: App,
  target: string,
  source: string,
  newLeaf = false,
): Promise<void> {
  const safe = nativeLinkPath(target, false);
  if (!safe) throw new Error('This is not a vault-note link.');
  const { path, subpath } = parseLinktext(safe);
  const file = app.metadataCache.getFirstLinkpathDest(path, source);
  if (!file) throw new Error('The linked note no longer exists. No note was created.');
  const expected = file.path;
  const assert = () => {
    if (file.path !== expected || app.vault.getAbstractFileByPath(expected) !== file)
      throw new Error('The linked note changed. Reopen the link.');
  };
  assert();
  const leaf = app.workspace.getLeaf(newLeaf);
  assert();
  await leaf.openFile(file, { active: true, ...(subpath ? { eState: { subpath } } : {}) });
}
