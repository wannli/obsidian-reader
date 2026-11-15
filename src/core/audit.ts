import { passages } from './annotations';
import { type Catalog, type DuplicateArticleUrl } from './catalog';
import { requireArticle } from './document';
import { paragraphAnchors } from './hosted-highlights';
import type { NoteFile, VaultPort } from './store';
import { WorkQueue } from './work';

export interface ReaderAuditOptions {
  signal?: AbortSignal;
  /** Article paths sorted lexically, not an age/canonical preference. */
  offset?: number;
  /** 1–100 source files per request; default 50. */
  limit?: number;
  /** Parser bound in UTF-16 code units; default/hard ceiling 200,000. */
  maxSourceLength?: number;
}
export interface UncertainLegacyAnchor {
  path: string;
  reason: 'duplicate-anchor' | 'missing-anchor' | 'ambiguous-anchor';
  blockId?: string;
  /** Source-body UTF-16 columns, evidence only; never a repair instruction. */
  from: number;
  to: number;
}
export interface ReaderAudit {
  duplicateUrls: readonly DuplicateArticleUrl[];
  uncertainLegacyAnchors: readonly UncertainLegacyAnchor[];
  coverage: {
    total: number;
    scanned: number;
    skipped: readonly { path: string; reason: 'unreadable' | 'changed' | 'oversized' }[];
    urlEvidence: 'observed-metadata';
    legacyEvidence: 'source-snapshots';
  };
  nextOffset?: number;
}
const cancelled = () => new DOMException('Reader audit cancelled.', 'AbortError');
function bound(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error('Invalid Reader audit bound.');
  return value;
}

/** Explicit, read-only source inspection. No startup scan, canonical selection or
 * repair. URL groups reflect observed metadata; source snapshots cover only the
 * requested article page, not all backlinks/notebooks or unsaved editor buffers.
 * VaultPort reads whole native files: oversized results are excluded from parsing.
 * A cancelled native read retains its one occupied slot until settlement. */
export class ReaderAuditor<File extends NoteFile> {
  private reads = new WorkQueue(1);
  private request = 0;
  constructor(
    private vault: VaultPort<File>,
    private catalog: Catalog,
    private assertActive: () => void,
  ) {}
  stop(): void {
    this.reads.stop();
  }
  async audit(options: ReaderAuditOptions = {}): Promise<ReaderAudit> {
    const { signal } = options;
    const offset = bound(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = bound(options.limit, 50, 1, 100);
    const maxLength = bound(options.maxSourceLength, 200_000, 1, 200_000);
    const check = () => {
      this.assertActive();
      if (signal?.aborted) throw cancelled();
    };
    check();
    const key = `audit:${++this.request}`;
    let report!: ReaderAudit;
    const work = this.reads.enqueue(key, async () => {
      check();
      const paths = [...this.catalog.values()].map((article) => article.path).sort();
      const page = paths.slice(offset, offset + limit);
      const uncertainLegacyAnchors: UncertainLegacyAnchor[] = [];
      const skipped: ReaderAudit['coverage']['skipped'][number][] = [];
      let scanned = 0;
      for (const path of page) {
        check();
        const file = this.vault.file(path);
        if (!file) {
          skipped.push({ path, reason: 'changed' });
          continue;
        }
        try {
          const raw = await this.vault.read(file);
          check();
          if (file.path !== path || this.vault.file(path) !== file) {
            skipped.push({ path, reason: 'changed' });
            continue;
          }
          if (raw.length > maxLength) {
            skipped.push({ path, reason: 'oversized' });
            continue;
          }
          const { body } = requireArticle(raw);
          const anchors = paragraphAnchors(body);
          const counts = new Map<string, number>();
          for (const anchor of anchors)
            counts.set(anchor.blockId, (counts.get(anchor.blockId) ?? 0) + 1);
          for (const [blockId, count] of counts) {
            if (count < 2) continue;
            const anchor = anchors.find((item) => item.blockId === blockId)!;
            uncertainLegacyAnchors.push({
              path,
              reason: 'duplicate-anchor',
              blockId,
              from: anchor.anchor.from,
              to: anchor.anchor.to,
            });
          }
          for (const passage of passages(body)) {
            const containing = anchors.filter(
              (anchor) => passage.from >= anchor.from && passage.to <= anchor.to,
            );
            // Duplicate IDs already have their own evidence row, not one row per mark.
            if (containing.length === 1) continue;
            uncertainLegacyAnchors.push({
              path,
              reason: containing.length ? 'ambiguous-anchor' : 'missing-anchor',
              from: passage.from,
              to: passage.to,
            });
          }
          scanned++;
        } catch {
          check();
          skipped.push({ path, reason: 'unreadable' });
        }
      }
      check();
      report = {
        duplicateUrls: this.catalog.duplicateUrls(),
        uncertainLegacyAnchors,
        coverage: {
          total: paths.length,
          scanned,
          skipped,
          urlEvidence: 'observed-metadata',
          legacyEvidence: 'source-snapshots',
        },
        ...(offset + page.length < paths.length ? { nextOffset: offset + page.length } : {}),
      };
    });
    return new Promise<ReaderAudit>((resolve, reject) => {
      const abort = () => {
        this.reads.cancelPending(key, cancelled());
        reject(cancelled());
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      void work.then(
        () => {
          signal?.removeEventListener('abort', abort);
          try {
            check();
            resolve(report);
          } catch (error) {
            reject(error);
          }
        },
        (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }
}
