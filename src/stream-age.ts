import { knownPublication } from './storage/article-path';

/** Previous calendar month, clamped to its final day, preserving UTC time. */
export function streamCutoff(now = new Date()): number {
  const cutoff = new Date(now);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
  const last = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, last));
  return cutoff.getTime();
}

/** Legacy fetched metadata is only a fallback; never infer age from filenames. */
export function expiredStreamItem(published: string | undefined, fetched: string | undefined, cutoff: number): boolean {
  const date = knownPublication(published) ?? knownPublication(fetched);
  return date !== undefined && Date.parse(date) < cutoff;
}
