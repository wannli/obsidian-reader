import { ChangedNote, readDocument } from '../core/document';
import { articleStatus } from '../core/model';
import type { ArticleStore, NoteFile } from '../core/store';

/** Session-only transitions, never a folder-difference scan or persistent migration queue. */
export class StatusObserver<File extends NoteFile> {
  private baseline = new WeakMap<File, unknown>();
  private sequences = new WeakMap<File, number>();
  private acceptedSequences = new WeakMap<File, number>();
  private validating = new WeakMap<File, number>();
  private invalidate(file: File): void {
    const sequence = (this.sequences.get(file) ?? 0) + 1;
    this.sequences.set(file, sequence);
    this.acceptedSequences.set(file, sequence);
  }
  private pending = new Map<
    File,
    { status: string; raw: string; path: string; generation: number }
  >();
  private running = new Set<File>();
  private active = true;
  private stopWrites: () => void;
  constructor(
    private store: ArticleStore<File>,
    private report: (error: unknown) => void,
  ) {
    this.stopWrites = store.observeStatusWrites((file, status, raw, changed) => {
      this.invalidate(file);
      if (changed) {
        this.baseline.set(file, status);
        this.pending.delete(file); // A newer Reader status write supersedes prior external intent.
      } else {
        if (this.baseline.has(file) && this.baseline.get(file) !== status) {
          this.accept(file, raw, status, true);
          return;
        }
        const pending = this.pending.get(file);
        if (pending && pending.status === status && pending.raw !== raw) {
          this.pending.set(file, { ...pending, raw });
          this.retry();
        }
      }
    });
  }
  seed(file: File, status: unknown, available = true): void {
    if (available && !this.baseline.has(file)) this.baseline.set(file, status);
    this.invalidate(file);
    this.pending.delete(file); // Path changes invalidate work, never regress known YAML from lagging cache.
  }
  forget(file: File): void {
    this.baseline.delete(file);
    this.pending.delete(file);
    this.invalidate(file);
  }
  changed(file: File, raw: string, status: unknown, ready: boolean): void {
    if (!this.active) return;
    // Own status writes updated the baseline synchronously. A delayed own body/
    // bookmark event must neither regress it nor consume newer external intent.
    if (this.store.acknowledgeStatus(file, raw)) return;
    const known = this.baseline.has(file),
      previous = this.baseline.get(file);
    const pending = this.pending.has(file),
      validating = this.validating.get(file) ?? 0;
    // Initial metadata is discovery, never a request to inspect/organize a vault.
    if (!ready || !known) {
      this.baseline.set(file, status);
      this.seed(file, status);
      return;
    }
    // Keep the disabled feature and unrelated notes metadata-only. Relevant
    // transitions still validate before changing their authoritative baseline.
    if (
      !pending &&
      !validating &&
      !this.store.hasStatusFolder(status) &&
      !this.store.hasStatusFolder(previous)
    ) {
      this.baseline.set(file, status);
      return;
    }
    if (!pending && !validating && status === previous) return;
    const sequence = (this.sequences.get(file) ?? 0) + 1;
    this.sequences.set(file, sequence);
    const path = file.path,
      generation = this.store.statusFolderGeneration;
    // Metadata delivery is not ordered write authority. Stale events must not
    // alter a baseline and later turn a body-only edit into a false transition.
    this.validating.set(file, validating + 1);
    void this.store.vault
      .read(file)
      .then((current) => {
        if (
          !this.active ||
          sequence < (this.acceptedSequences.get(file) ?? 0) ||
          file.path !== path ||
          this.store.vault.file(path) !== file ||
          generation !== this.store.statusFolderGeneration ||
          current !== raw
        )
          return;
        const properties = readDocument(raw).properties;
        const actual = properties.type === 'article' ? properties.status : undefined;
        if (actual !== status) return;
        this.acceptedSequences.set(file, sequence);
        this.accept(file, raw, status, ready);
      })
      .catch(() => {
        /* Incomplete/stale/deleted documents do not authorize organization. */
      })
      .finally(() => {
        this.validating.set(file, (this.validating.get(file) ?? 1) - 1);
      });
  }
  private accept(file: File, raw: string, status: unknown, ready: boolean): void {
    const known = this.baseline.has(file),
      previous = this.baseline.get(file);
    this.baseline.set(file, status);
    if (!ready || !known) return;
    if (status !== previous) {
      this.pending.delete(file);
      if (articleStatus(status) && this.store.hasStatusFolder(status)) {
        if (this.pending.size >= 128) {
          this.report(
            new Error('Too many pending status folder moves; this transition was not moved.'),
          );
          return;
        }
        this.pending.set(file, {
          status: status as string,
          raw,
          path: file.path,
          generation: this.store.statusFolderGeneration,
        });
      }
    } else {
      const pending = this.pending.get(file);
      if (pending && pending.raw !== raw) this.pending.set(file, { ...pending, raw }); // Follow a later editor save without authorizing a new transition.
    }
    this.retry();
  }
  retry(): void {
    if (!this.active) return;
    for (const [file, pending] of this.pending) {
      if (
        pending.path !== file.path ||
        pending.generation !== this.store.statusFolderGeneration ||
        this.store.vault.file(file.path) !== file
      ) {
        this.pending.delete(file);
        continue;
      }
      if (this.running.has(file)) continue;
      // Unsafe native editors defer, rather than silently losing the transition.
      try {
        this.store.vault.assertWritable(file, pending.raw);
      } catch {
        continue;
      }
      this.running.add(file);
      const valid = () => {
        if (
          !this.active ||
          this.pending.get(file) !== pending ||
          pending.path !== file.path ||
          pending.generation !== this.store.statusFolderGeneration
        )
          throw new ChangedNote();
      };
      void this.store
        .observedStatusChange(file, pending.raw, valid, pending.status)
        .then(
          () => {
            if (this.pending.get(file) === pending) this.pending.delete(file);
          },
          (error) => {
            if (this.pending.get(file) !== pending) return;
            try {
              this.store.vault.assertWritable(file, pending.raw);
            } catch {
              return;
            }
            this.pending.delete(file);
            if (
              this.active &&
              pending.path === file.path &&
              pending.generation === this.store.statusFolderGeneration
            )
              this.report(error);
          },
        )
        .finally(() => {
          this.running.delete(file);
          if (this.active && this.pending.has(file) && this.pending.get(file) !== pending)
            this.retry();
        });
    }
  }
  stop(): void {
    this.active = false;
    this.pending.clear();
    this.stopWrites();
  }
}
