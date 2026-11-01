export interface NodesSettings {
  nodesFolder: string;
  classProperty: string;
}

export const DEFAULT_SETTINGS: NodesSettings = {
  nodesFolder: 'Nodes',
  classProperty: 'fileClass',
};

export function validateSettings(settings: NodesSettings): string | null {
  const folder = settings.nodesFolder;
  if (
    typeof folder !== 'string' ||
    !folder ||
    folder !== folder.trim() ||
    folder.startsWith('/') ||
    folder.endsWith('/') ||
    folder.includes('\\') ||
    folder
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part === '.obsidian' ||
          /[\\:*?"<>|\x00-\x1f]/.test(part),
      )
  )
    return 'Use a vault-relative capture folder without invalid segments.';
  const property = settings.classProperty;
  if (
    typeof property !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(property) ||
    ['__proto__', 'prototype', 'constructor'].includes(property)
  )
    return 'Use a simple fallback binding property matching Fileclass’s alias.';
  return null;
}
