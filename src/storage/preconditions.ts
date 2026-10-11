import { isAcquisitionUrl } from '../acquisition-url';
import type { Note } from './markdown';

/** Transient original-request identity; never persisted in the note. */
export interface AcquisitionWriteOptions { expectedUrl?: string; expectedBody?: string; expectedRevision?: string; expectedGeneration?: number; }

/** Discard this result/failure. It must not become a new error/retry write. */
export class StaleArticleWriteError extends Error {
  readonly code = 'STALE_ARTICLE_WRITE';
  constructor() {
    super('Article source URL changed or is invalid; stale acquisition write discarded');
    this.name = 'StaleArticleWriteError';
  }
}

/** Exact comparison intentionally detects URL edits; this is not URL deduplication. */
export function assertExpectedArticleUrl(note: Note, expectedUrl: string | undefined): void {
  if (expectedUrl === undefined) return;
  const currentUrl = note.doc.get('url');
  if (!isAcquisitionUrl(expectedUrl) || !isAcquisitionUrl(currentUrl) || currentUrl !== expectedUrl)
    throw new StaleArticleWriteError();
}
