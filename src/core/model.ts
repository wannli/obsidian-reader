import { defaultFolders, isWithinFolder, type ReaderFolders } from './folders';

export const queues = ['Inbox', 'Later', 'Stream', 'Treasury'] as const;
export type Queue = (typeof queues)[number];
export type Properties = Record<string, unknown>;
export interface ArticleInfo {
  path: string;
  title: string;
  url: string;
  queue?: Queue;
  published?: string;
  feed?: string;
  topics: string[];
  date: number;
  error?: string;
}
export interface Subscription {
  path: string;
  title: string;
  url: string;
  prefix: string;
  enabled: boolean;
  error?: string;
}
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function webUrl(input: string, base?: string): string {
  const url = new URL(input.trim(), base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP(S) URL without credentials.');
  url.hash = '';
  return url.href;
}
export function queueFolder(queue: Queue, folders: ReaderFolders = defaultFolders): string {
  const keys = { Inbox: 'inbox', Stream: 'stream', Later: 'later', Treasury: 'treasury' } as const;
  return folders[keys[queue]];
}
export function queueAt(path: string, folders: ReaderFolders = defaultFolders): Queue | undefined {
  return queues.find((queue) => isWithinFolder(path, queueFolder(queue, folders)));
}
export function timestamp(input: unknown): number | undefined {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(input)) return;
  const value = Date.parse(input);
  if (!Number.isFinite(value)) return;
  // Date.parse otherwise rolls invalid dates such as February 30 into March.
  const [year, month, day] = input.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return;
  return value;
}
/** New publication writes only; existing note values are never normalized on read. */
export function formatPublished(input: unknown): string | undefined {
  const value = timestamp(input);
  if (value === undefined) return;
  const date = new Date(value),
    pad = (part: number) => String(part).padStart(2, '0');
  const minute = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return timestamp(minute) === undefined ? undefined : minute;
}
/** A minute-only publication may have lost seconds; retain its entire parsed minute. */
export function publicationBefore(published: unknown, cutoff: number, fallback?: number): boolean {
  const publishedAt = timestamp(published),
    date = publishedAt ?? fallback;
  if (date === undefined) return false;
  const minute =
    publishedAt !== undefined &&
    typeof published === 'string' &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(published);
  return minute ? date + 60_000 <= cutoff : date < cutoff;
}
export function filenameDay(path: string): number | undefined {
  const match = /^(\d{2})(\d{2})(\d{2}) /.exec(path.split('/').pop() ?? '');
  return match ? timestamp(`20${match[1]}-${match[2]}-${match[3]}`) : undefined;
}
export function monthCutoff(now: Date): number {
  const year = now.getUTCFullYear(),
    month = now.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Date.UTC(
    year,
    month - 1,
    Math.min(now.getUTCDate(), lastDay),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  );
}
export function articleInfo(
  path: string,
  properties: Properties,
  folders: ReaderFolders = defaultFolders,
): ArticleInfo | undefined {
  if (properties.type !== 'article') return;
  const name = path.split('/').pop()!.replace(/\.md$/i, '');
  let url = '';
  try {
    if (text(properties.url)) url = webUrl(text(properties.url));
  } catch {
    /* Still readable; cannot acquire this source. */
  }
  const published =
    timestamp(properties.published) === undefined ? undefined : text(properties.published);
  return {
    path,
    title: text(properties.title).trim() || name.replace(/^\d{6} /, ''),
    url,
    queue: queueAt(path, folders),
    published,
    feed: text(properties.feed) || undefined,
    topics: Array.isArray(properties.topics)
      ? properties.topics.filter((item): item is string => typeof item === 'string')
      : [],
    date: timestamp(published) ?? filenameDay(path) ?? 0,
    error: text(properties.error) || undefined,
  };
}
export function subscription(path: string, properties: Properties): Subscription | undefined {
  if (properties.type !== 'feed') return;
  const title = text(properties.title).trim() || path.split('/').pop()!.replace(/\.md$/i, '');
  return {
    path,
    title,
    url: text(properties.url),
    prefix: text(properties.prefix).trim() || title,
    enabled: properties.enabled !== false,
    error: text(properties.error) || undefined,
  };
}
export function filename(title: string, date: Date, prefix = '', utc = false): string {
  const y = utc ? date.getUTCFullYear() : date.getFullYear();
  const m = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
  const d = utc ? date.getUTCDate() : date.getDate();
  const day = `${String(y).slice(-2)}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  const safe = (value: string) =>
    value
      .normalize('NFC')
      .replace(/[\\/:*?"<>|\[\]#^\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[ .]+$/g, '')
      .trim();
  const encoder = new TextEncoder();
  const fit = (value: string, budget: number) => {
    let size = 0,
      result = '';
    for (const character of value) {
      size += encoder.encode(character).length;
      if (size > budget) break;
      result += character;
    }
    return result.replace(/[ .]+$/g, '');
  };
  const source = fit(safe(prefix), 80);
  const lead = source ? `${source} - ` : '';
  // Leave room for the date, extension and collision suffix on 255-byte filesystems.
  const name = lead + fit(safe(title) || 'Untitled', 220 - encoder.encode(lead).length);
  return `${day} ${name}.md`;
}
export function vaultLink(path: string): string {
  if (!path || /[\[\]|#^\r\n]/.test(path))
    throw new Error('This note path cannot be represented as a safe wiki-link.');
  return `[[${path}]]`;
}
export function linkPath(link: string): string | undefined {
  return /^\[\[([^\]|#^]+)(?:\|[^\]]*)?\]\]$/.exec(link)?.[1];
}
