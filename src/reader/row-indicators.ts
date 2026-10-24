import { setIcon, setTooltip } from 'obsidian';
import { readDocument, readingMarker } from '../core/document';
import { renderedHighlight } from '../core/markdown';

interface EvidenceFile {
  path: string;
  stat: { mtime: number; size: number };
}
/** Shared across list mounts: abandoned reads keep their occupied slots until settlement. */
export class IndicatorReadSlots {
  active = 0;
  pump?: () => void;
}
interface EvidenceHost<File extends EvidenceFile> {
  file(path: string): File | undefined;
  read(file: File): Promise<string>;
  signal: AbortSignal;
  hostSignal: AbortSignal;
  active(): boolean;
}

/** Disposable, visible-row evidence. Nothing is persisted or added to the catalog. */
export class RowIndicators<File extends EvidenceFile> {
  private rows = new Map<HTMLElement, string>();
  private revisions = new Map<HTMLElement, number>();
  private nextRevision = 0;
  private dirty = new Set<HTMLElement>();
  private visible = new Set<HTMLElement>();
  private pending = new Set<HTMLElement>();
  private reading = new Set<HTMLElement>();
  private observer?: IntersectionObserver;
  private closed = false;
  constructor(
    private list: HTMLElement,
    private host: EvidenceHost<File>,
    private slots: IndicatorReadSlots,
  ) {
    const Observer = list.ownerDocument.defaultView?.IntersectionObserver;
    if (typeof Observer !== 'function') return;
    this.observer = new Observer(
      (entries) => {
        if (!this.active()) return;
        for (const entry of entries) {
          const row = entry.target as HTMLElement;
          if (!this.rows.has(row)) continue;
          if (entry.isIntersecting) {
            this.visible.add(row);
            this.enqueue(row);
          } else {
            this.visible.delete(row);
            this.pending.delete(row);
          }
        }
        this.pump();
      },
      { root: list },
    );
    slots.pump = this.pump;
    host.signal.addEventListener('abort', this.dispose, { once: true });
    host.hostSignal.addEventListener('abort', this.dispose, { once: true });
  }
  update(rows: ReadonlyMap<HTMLElement, string>): void {
    if (this.closed) return;
    for (const row of this.rows.keys()) {
      if (rows.has(row)) continue;
      this.observer?.unobserve(row);
      this.rows.delete(row);
      this.revisions.delete(row);
      this.dirty.delete(row);
      this.visible.delete(row);
      this.pending.delete(row);
    }
    for (const [row, path] of rows) {
      if (this.rows.get(row) === path) continue;
      this.rows.set(row, path);
      this.invalidateRow(row);
      this.observer?.observe(row);
    }
    this.pump();
  }
  invalidate(path: string): void {
    for (const [row, current] of this.rows) if (current === path) this.invalidateRow(row);
    this.pump();
  }
  private invalidateRow(row: HTMLElement): void {
    this.revisions.set(row, ++this.nextRevision);
    this.dirty.add(row);
    row.querySelectorAll('.reader-row-indicator').forEach((indicator) => indicator.remove());
    this.enqueue(row);
  }
  private enqueue(row: HTMLElement): void {
    if (this.dirty.has(row) && this.visible.has(row) && !this.reading.has(row))
      this.pending.add(row);
  }
  private active(): boolean {
    return (
      !this.closed &&
      !this.host.signal.aborted &&
      !this.host.hostSignal.aborted &&
      this.host.active() &&
      this.list.isConnected
    );
  }
  private pump = (): void => {
    while (this.active() && this.slots.active < 2 && this.pending.size) {
      const row = this.pending.values().next().value!;
      this.pending.delete(row);
      const path = this.rows.get(row),
        revision = this.revisions.get(row);
      if (!path || !this.visible.has(row) || !row.isConnected) continue;
      const file = this.host.file(path);
      if (!file?.stat) continue;
      const { mtime, size } = file.stat;
      this.slots.active++;
      this.reading.add(row);
      void (async () => {
        const raw = await this.host.read(file);
        if (
          !this.active() ||
          !this.visible.has(row) ||
          !row.isConnected ||
          this.revisions.get(row) !== revision ||
          this.rows.get(row) !== path ||
          file.path !== path ||
          this.host.file(path) !== file ||
          file.stat.mtime !== mtime ||
          file.stat.size !== size
        )
          return;
        const document = readDocument(raw);
        if (document.properties.type !== 'article') return;
        let highlighted = false;
        try {
          highlighted = renderedHighlight(document.body);
        } catch {
          // Uncertain grammar must not erase known position evidence.
        }
        row.querySelectorAll('.reader-row-indicator').forEach((indicator) => indicator.remove());
        for (const [present, name, icon, label] of [
          [
            !!readingMarker(document.properties.bookmark),
            'reader-opened-indicator',
            'eye',
            'Opened before',
          ],
          [highlighted, 'reader-highlight-indicator', 'highlighter', 'Has highlights'],
        ] as const) {
          if (!present) continue;
          const indicator = row.ownerDocument.createElement('span');
          indicator.className = `reader-row-indicator ${name}`;
          indicator.setAttribute('role', 'img');
          indicator.setAttribute('aria-label', label);
          row.append(indicator);
          setIcon(indicator, icon);
          setTooltip(indicator, label);
          indicator.querySelector('svg')?.setAttribute('aria-hidden', 'true');
        }
        this.dirty.delete(row);
      })()
        .catch(() => {
          // Read failures leave the title usable. Retry only on a new event/intersection.
        })
        .finally(() => {
          this.reading.delete(row);
          this.slots.active--;
          if (this.revisions.get(row) !== revision) this.enqueue(row);
          this.slots.pump?.();
        });
    }
  };
  dispose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.observer?.disconnect();
    this.rows.clear();
    this.revisions.clear();
    this.pending.clear();
    this.visible.clear();
    this.dirty.clear();
    if (this.slots.pump === this.pump) this.slots.pump = undefined;
    this.host.signal.removeEventListener('abort', this.dispose);
    this.host.hostSignal.removeEventListener('abort', this.dispose);
  };
}
