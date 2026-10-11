import type { FileStore } from '../types';
import { normalizeUrl } from '../ingest/url';
export { normalizeUrl } from '../ingest/url';

export function safePath(path: string, markdown = false): string {
  if (!path || /[\\\x00-\x1f\x7f]/.test(path) || /^[A-Za-z]:/.test(path) || path.startsWith('/'))
    throw new Error('Unsafe vault path: ' + path);
  for (const part of path.split('/')) {
    let decoded = part;
    try { decoded = decodeURIComponent(part); } catch { /* A literal percent is a valid filename. */ }
    if (!part || part === '.' || part === '..' || decoded === '.' || decoded === '..' || /[/\\]/.test(decoded))
      throw new Error('Unsafe vault path: ' + path);
  }
  if (markdown && !/\.md$/i.test(path)) throw new Error('Expected a Markdown path: ' + path);
  return path;
}

/** Compare all entries and implicit parents without normalizing the requested path. */
export function assertUnambiguousNotePath(entries: Iterable<{ path: string; folder?: boolean }>, target: string): void {
  const fold = (value: string) => value.normalize('NFC').toLowerCase();
  const wanted = target.split('/');
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let index = 1; index <= Math.min(parts.length, wanted.length); index++) {
      const actual = parts.slice(0, index).join('/'), expected = wanted.slice(0, index).join('/');
      if (fold(actual) !== fold(expected)) continue;
      const isFolder = index < parts.length || entry.folder;
      if (actual !== expected || (index < wanted.length && !isFolder) || (index === wanted.length && isFolder))
        throw new Error('An ambiguous Nodes path or filename already exists: ' + entry.path);
    }
  }
}

export function sameUrl(left: string, right: string): boolean {
  try { return normalizeUrl(left) === normalizeUrl(right); } catch { return false; }
}

let sequence = 0;
export function uniqueId(prefix: string, used: Iterable<string>): string {
  const ids = new Set(used);
  for (;;) {
    const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
    const id = prefix + '-' + random.replace(/[^a-z0-9]/gi, '').slice(0, 16) + '-' + (++sequence).toString(36);
    if (!ids.has(id)) return id;
  }
}

export function localDay(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('Invalid highlight creation date');
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function filenameText(value: string, maxBytes = 240): string {
  let result = '', bytes = 0;
  for (const character of value.normalize('NFC')) {
    const point = character.codePointAt(0)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size; result += character;
  }
  return result;
}
export function notePath(folder: string, title: string, paths: string[]): string {
  if (folder) safePath(folder);
  const name = filenameText(title.replace(/[\\/:*?"<>|#^[\]\x00-\x1f\x7f]/g, '-').replace(/^[. ]+|[. ]+$/g, '')) || 'Untitled';
  const used = new Set(paths.map(path => path.normalize('NFC').toLowerCase()));
  for (let index = 1; ; index++) {
    const suffix = (index === 1 ? '' : '-' + index) + '.md';
    const path = (folder ? folder + '/' : '') + filenameText(name, 240 - suffix.length) + suffix;
    if (!used.has(path.normalize('NFC').toLowerCase())) return safePath(path, true);
  }
}

const queues = new WeakMap<FileStore, Promise<void>>();
/** Serializes this process's repository operations, not other devices or vault writers. */
export function queued<T>(store: FileStore, operation: () => Promise<T>): Promise<T> {
  const result = (queues.get(store) ?? Promise.resolve()).then(operation);
  queues.set(store, result.then(() => {}, () => {}));
  return result;
}
