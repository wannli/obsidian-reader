import type { Note } from './markdown';
import { safePath } from './safety';
import { fingerprint } from './fingerprint';
export type RelationshipProperty = 'topics' | 'authors';
/** Bind each YAML entry to the target the picker actually displayed. An unchanged
 * bare wikilink can resolve elsewhere after a create/rename/delete in the vault. */
export function relationshipRevision(note: Note, property: RelationshipProperty, path: string, files: readonly string[]): string {
  return fingerprint(JSON.stringify({ present: note.doc.has(property), value: note.doc.toJS({ maxAliasCount: 50 })[property],
    resolved: topicValues(note, property).map(value => topicPath(value, path, files) ?? null) }));
}

export function topicValues(note: Note, property: RelationshipProperty = 'topics'): unknown[] {
  const value = note.doc.toJS({ maxAliasCount: 50 })[property];
  return Array.isArray(value) ? value : [];
}
export function topicLink(path: string): string {
  const target = path.replace(/\.md$/i, '').replace(/[%#^\[\]|]/g, char => encodeURIComponent(char));
  return '[[' + target + ']]';
}

/** Native wiki aliases are read but never reformatted during unrelated assignments. */
export function topicPath(value: unknown, articlePath: string, files: readonly string[]): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\[\[([^\[\]|\r\n]+)(?:\|([^\[\]\r\n]*))?\]\]$/.exec(value);
  if (!match) return undefined;
  let target = match[1].split('#')[0].trim();
  try { target = decodeURIComponent(target); } catch { /* A literal percent may be a filename. */ }
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  if (!/\.md$/i.test(target)) target += '.md';
  try { safePath(target, true); } catch { return undefined; }
  const markdown = files.filter(path => /\.md$/i.test(path));
  const exact = (path: string) => {
    if (markdown.includes(path)) return path;
    const matches = markdown.filter(file => file.toLowerCase() === path.toLowerCase());
    return matches.length === 1 ? matches[0] : undefined;
  };
  const direct = exact(target);
  if (direct) return direct;
  const directory = articlePath.includes('/') ? articlePath.slice(0, articlePath.lastIndexOf('/') + 1) : '';
  const relative = directory ? exact(directory + target) : undefined;
  if (relative) return relative;
  if (!target.includes('/')) {
    const matches = markdown.filter(file => file.split('/').pop()!.toLowerCase() === target.toLowerCase());
    if (matches.length > 1) return undefined; // Never guess between same-named files.
    if (matches.length === 1) return matches[0];
  }
  return target; // Keep unambiguous explicit/stale references removable by their full path.
}
export function readTopics(note: Note, path: string, files: readonly string[] = [], property: RelationshipProperty = 'topics'): string[] {
  return [...new Set(topicValues(note, property).map(value => topicPath(value, path, files)).filter((value): value is string => !!value))];
}
