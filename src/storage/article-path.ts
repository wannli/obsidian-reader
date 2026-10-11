import type { NewArticle } from '../types';
import { queueFolder } from '../reading-layout';
import { filenameText, localDay, notePath } from './safety';

/** Unknown publication dates affect the filename fallback only, never publication metadata. */
export function knownPublication(value: string | undefined): string | undefined {
  if (!value?.trim() || !Number.isFinite(Date.parse(value))) return undefined;
  const day = /^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/.exec(value)?.[1];
  if (day && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day) return undefined;
  return value;
}

export function articlePath(input: NewArticle, paths: string[], prefix?: string, added = new Date()): string {
  const imported = !!input.feed || input.status === 'feed';
  const published = imported ? knownPublication(input.published) : undefined;
  const day = published ? new Date(published).toISOString().slice(0, 10) : localDay(added);
  const stamp = day.slice(2).replace(/-/g, '');
  const title = input.title.trim() || 'Untitled';
  const name = stamp + ' ' + (imported ? filenameText(prefix?.trim() || 'Feed', 80) + ' - ' : '') + title;
  return notePath(queueFolder(input.status ?? 'inbox'), name, paths);
}
