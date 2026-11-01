import { TFile, type App } from 'obsidian';
import type { FileclassBridge } from './fileclass';
import type { ClassInfo } from './fileclass-contract';
import type { PublicApi } from './fileclass-fields';
import type { NodeIndex } from './index';
import type { Catalog } from './fileclass-cache-signature';

interface Dirty {
  file: TFile;
  revision: object;
}
export const NOTE_WINDOW = 5_000;
export const IDLE_RECONCILE = 120_000;

/** Shared internal state. Public callers only see FileclassCache's lifecycle/cache API. */
export class CacheState {
  protected live = false;
  protected disposed = false;
  protected observed?: PublicApi;
  protected connection?: PublicApi;
  protected cancellation = new AbortController();
  protected epoch = 0;
  protected catalog: ClassInfo[] = [];
  protected byName = new Map<string, ClassInfo>();
  protected signature?: string;
  protected prepared?: Catalog;
  protected dirty = new Map<string, Dirty>();
  protected revisions = new Map<string, object>();
  protected recent = new Map<string, { file: TFile; time: number }>();
  protected lastActivity = -Infinity;
  protected lastFull = -Infinity;
  protected fullWanted = false;
  protected indexedWanted = false;
  protected unknownIndexed = false;
  protected dirtyReady = false;
  protected building = false;
  protected buildingToken?: PublicApi;
  protected idleWanted = false;

  constructor(
    protected readonly app: App,
    protected readonly backend: FileclassBridge,
    protected readonly index: NodeIndex,
    private readonly disconnected: () => void,
  ) {}

  protected raw(): PublicApi | undefined {
    try {
      return this.backend.token();
    } catch {
      return undefined;
    }
  }
  protected reset(token?: PublicApi, failed = false): void {
    const hadConnection = !!this.connection;
    this.epoch++;
    this.cancellation.abort();
    this.cancellation = new AbortController();
    this.observed = token;
    this.connection = failed ? undefined : token;
    this.catalog = [];
    this.byName.clear();
    this.signature = undefined;
    this.prepared = undefined;
    this.dirty.clear();
    this.revisions.clear();
    this.recent.clear();
    this.fullWanted = !!this.connection;
    this.indexedWanted = this.unknownIndexed = this.dirtyReady = this.idleWanted = false;
    this.lastActivity = this.lastFull = -Infinity;
    this.index.clear();
    this.resetTimers();
    if (hadConnection) this.disconnected();
  }
  protected resetTimers(): void {}
  protected check(token: PublicApi, epoch: number): void {
    if (!this.live || epoch !== this.epoch || this.raw() !== token || this.connection !== token) {
      throw new Error('Stale Fileclass cache operation');
    }
  }
  protected current(file: TFile, path: string): boolean {
    return file.path === path && this.app.vault.getAbstractFileByPath(path) === file;
  }
  protected enqueue(file: TFile): void {
    if (!this.live || !this.connection || file.extension !== 'md' || !this.current(file, file.path))
      return;
    const revision = {};
    this.revisions.set(file.path, revision);
    this.dirty.set(file.path, { file, revision });
  }
  protected forget(file: TFile, path: string): void {
    const replacement = this.app.vault.getAbstractFileByPath(path);
    if (replacement && replacement !== file) return; // A late delete must not evict a replacement.
    this.revisions.delete(path);
    this.dirty.delete(path);
    this.recent.delete(path);
    this.index.forget(path); // The index overlays this tombstone onto any pending full snapshot.
  }
  protected replayRecent(): void {
    const now = Date.now();
    for (const { file, time } of this.recent.values()) {
      if (now - time < NOTE_WINDOW) this.enqueue(file);
    }
    this.recent.clear();
    this.dirtyReady = true;
  }
  protected publish(catalog: Catalog): void {
    this.catalog = catalog.types;
    this.byName = new Map(catalog.types.map((info) => [info.name, info]));
    this.signature = catalog.signature;
  }
}
