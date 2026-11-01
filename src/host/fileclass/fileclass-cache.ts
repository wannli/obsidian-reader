import { Events, TFile, type TAbstractFile } from 'obsidian';
import type { ClassInfo } from './fileclass-contract';
import { CacheWork } from './fileclass-cache-work';
import { IDLE_RECONCILE, NOTE_WINDOW } from './fileclass-cache-state';
import { untilAborted } from './fileclass-cache-signature';

/** Cached public Fileclass v1 catalog and event-driven note membership. */
export class FileclassCache extends CacheWork {
  private hooks: (() => void)[] = [];
  private health?: ReturnType<typeof setInterval>;
  private notesTimer?: ReturnType<typeof setTimeout>;
  private indexedTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private recentPruned = -Infinity;

  start(): void {
    if (this.live || this.disposed) return;
    this.live = true;
    const listen = (events: Events, name: string, callback: (...args: any[]) => void): void => {
      if (typeof events?.on !== 'function') return;
      const ref = events.on(name, callback);
      this.hooks.push(() => events.offref?.(ref));
    };
    listen(this.app.metadataCache, 'changed', (file: TFile) => this.changed(file));
    listen(this.app.vault, 'create', (file: TAbstractFile) => this.changed(file));
    listen(this.app.vault, 'delete', (file: TAbstractFile) => this.removed(file, file.path));
    listen(this.app.vault, 'rename', (file: TAbstractFile, oldPath: string) => {
      this.removed(file, oldPath);
      if (file instanceof TFile) this.changed(file);
    });
    listen(this.app.workspace as Events, 'fileclass:indexed', () => this.indexed());
    // Identity checks only: never enumerate classes/schema/notes on a healthy tick.
    this.health = setInterval(() => this.syncConnection(), 1_000);
    this.syncConnection();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.live = false;
    clearInterval(this.health);
    this.health = undefined;
    for (const unhook of this.hooks.splice(0)) unhook();
    this.reset();
  }

  available(): boolean {
    if (!this.live) return false;
    this.syncConnection();
    return !!this.connection && this.signature !== undefined && this.connection === this.raw();
  }
  types(): ClassInfo[] {
    return this.available() ? this.catalog : [];
  }
  typeInfo(name: string): ClassInfo | undefined {
    return this.available() ? this.byName.get(name) : undefined;
  }

  async refresh(): Promise<void> {
    if (!this.live) return;
    this.syncConnection();
    if (!this.connection) {
      const raw = this.raw();
      if (!raw) return;
      this.reset(raw); // Explicit refresh may retry a previously failed source.
    }
    if (!this.building || this.buildingToken !== this.connection) this.fullWanted = true;
    this.dirtyReady = true;
    await untilAborted(this.pump(), this.cancellation.signal);
  }

  private syncConnection(): void {
    if (!this.live) return;
    const raw = this.raw();
    if (raw !== this.observed) {
      this.reset(raw);
      if (raw) void this.pump();
    }
  }
  protected override resetTimers(): void {
    clearTimeout(this.notesTimer);
    clearTimeout(this.indexedTimer);
    clearTimeout(this.idleTimer);
    this.notesTimer = this.indexedTimer = this.idleTimer = undefined;
  }
  private activity(): void {
    this.lastActivity = Date.now();
    // Batch pruning: a mass import must not traverse all recent notes per event.
    if (this.lastActivity - this.recentPruned >= NOTE_WINDOW) {
      for (const [path, note] of this.recent) {
        if (this.lastActivity - note.time >= NOTE_WINDOW) this.recent.delete(path);
      }
      this.recentPruned = this.lastActivity;
    }
    if (this.idleWanted) this.armIdle();
  }
  private changed(file: TAbstractFile): void {
    if (!this.live) return;
    this.syncConnection();
    if (!this.connection) return;
    if (!(file instanceof TFile)) {
      this.folderChanged();
      return;
    }
    if (file.extension !== 'md' || !this.current(file, file.path)) return;
    this.activity();
    this.recent.set(file.path, { file, time: this.lastActivity });
    this.enqueue(file);
    this.dirtyReady = false;
    clearTimeout(this.notesTimer);
    this.notesTimer = setTimeout(() => {
      this.notesTimer = undefined;
      this.dirtyReady = true;
      void this.pump();
    }, 150);
  }
  private removed(file: TAbstractFile, path: string): void {
    if (!this.live) return;
    if (!(file instanceof TFile)) {
      this.folderChanged();
      return;
    }
    if (!path.endsWith('.md')) return;
    this.activity();
    this.forget(file, path);
    if (this.fullWanted) void this.pump();
  }
  private folderChanged(): void {
    this.index.clear();
    this.dirty.clear();
    this.revisions.clear();
    this.recent.clear();
    if (this.connection) {
      this.fullWanted = true;
      void this.pump();
    }
  }
  private indexed(): void {
    if (!this.live) return;
    this.syncConnection();
    if (!this.connection) return;
    const known = Date.now() - this.lastActivity < NOTE_WINDOW;
    this.unknownIndexed ||= !known;
    if (known) {
      this.idleWanted = true;
      this.armIdle();
    }
    clearTimeout(this.indexedTimer);
    this.indexedTimer = setTimeout(() => {
      this.indexedTimer = undefined;
      this.indexedWanted = true;
      void this.pump();
    }, 150);
  }
  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.live || !this.idleWanted) return;
    // v1 does not expose global aliases/classes/bookmark settings in getSchema(). An
    // indexed event overlapping a note edit is ambiguous: eventual consistency is
    // bounded by a low-priority reconciliation, at most once/120s and only after
    // >=5s without note activity (continuous editing deliberately delays it).
    const due = Math.max(this.lastFull + IDLE_RECONCILE, this.lastActivity + NOTE_WINDOW);
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = undefined;
        if (!this.live || !this.idleWanted || !this.connection) return;
        if (
          Date.now() < Math.max(this.lastFull + IDLE_RECONCILE, this.lastActivity + NOTE_WINDOW)
        ) {
          this.armIdle();
          return;
        }
        this.idleWanted = false;
        this.fullWanted = true;
        void this.pump();
      },
      Math.max(0, due - Date.now()),
    ); // A real timer yields the foreground/UI thread.
  }
}
