import type { ArticleStatus } from './types';

/** Queue identity belongs to these paths, not a stored status property. */
const labels: Record<ArticleStatus, string> = {
  feed: 'Stream', inbox: 'Inbox', later: 'Later', archive: 'Treasury',
};
export const WIRES_FOLDER = 'Reading/Wires';
export function queueLabel(status: ArticleStatus): string { return labels[status]; }
export function queueFolder(status: ArticleStatus): string {
  if (!Object.prototype.hasOwnProperty.call(labels, status)) throw new Error('Invalid article status');
  return 'Reading/' + labels[status];
}
export function statusFromPath(path: string): ArticleStatus | undefined {
  return (Object.keys(labels) as ArticleStatus[]).find(status => path.startsWith(queueFolder(status) + '/'));
}
