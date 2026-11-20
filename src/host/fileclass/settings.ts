import type { ClippingBinding } from '../../core/clippings';

export interface NodesSettings {
  nodesFolder: string;
  classProperty: string;
  clippingType?: string;
  /** Past capture bindings keep old clipping types discoverable without rewriting notes. */
  clippingBindings?: ClippingBinding[];
}

export const DEFAULT_SETTINGS: NodesSettings = {
  nodesFolder: 'Nodes',
  classProperty: 'fileClass',
};

export function validateSettings(settings: NodesSettings): string | null {
  if (
    settings.clippingType !== undefined &&
    (typeof settings.clippingType !== 'string' ||
      settings.clippingType !== settings.clippingType.trim())
  )
    return 'Choose a valid clipping Fileclass.';
  if (
    settings.clippingBindings !== undefined &&
    (!Array.isArray(settings.clippingBindings) ||
      settings.clippingBindings.some(
        (binding) =>
          !binding ||
          typeof binding.property !== 'string' ||
          !binding.property.trim() ||
          /[\r\n]/.test(binding.property) ||
          ['__proto__', 'prototype', 'constructor', 'origin'].includes(binding.property) ||
          typeof binding.type !== 'string' ||
          !binding.type.trim(),
      ))
  )
    return 'Invalid saved clipping bindings; existing notes were not changed.';
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
