import type { App, TFile } from 'obsidian';
import { ArticleStore } from '../core/store';
import type { ReaderFolders } from '../core/folders';
import type { StatusFolders } from '../core/status-folders';
import { Ingestion } from './ingestion';
import type { Network } from './network';
import { ObsidianVault, watchLibrary, type LibraryChange } from './vault';

/** One folder generation. The shared network and native presentation lanes stay plugin-owned. */
export class FolderRuntime {
  private controller = new AbortController();
  private stopped = false;
  private stopIndex?: () => void;
  vault!: ObsidianVault;
  store!: ArticleStore<TFile>;
  ingestion!: Ingestion;
  readonly attempted = new Set<string>();
  readonly promotions = new Map<TFile, boolean>();
  readonly promoting = new Set<TFile>();
  lastMaintenance = 0;
  refreshing = false;
  referencesReady = false;
  referencesRecovered = false;
  startupCaptureRecoveryPending: boolean;
  readonly deferredCaptureSeeds: Set<TFile>;
  constructor(options: { recoverStartup?: boolean; deferredSeeds?: readonly TFile[] } = {}) {
    this.startupCaptureRecoveryPending = options.recoverStartup ?? true;
    this.deferredCaptureSeeds = new Set(options.deferredSeeds ?? []);
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  start(
    app: App,
    folders: ReaderFolders,
    statusFolders: StatusFolders,
    network: Network,
    changed: (change: LibraryChange) => void,
    notice: (message: string) => void,
  ): void {
    if (this.stopped || this.store) throw new Error('Reader folder runtime cannot restart.');
    const signal = this.signal;
    try {
      this.vault = new ObsidianVault(app, () => !signal.aborted);
      this.store = new ArticleStore(this.vault, folders);
      this.store.setStatusFolders(statusFolders);
      this.ingestion = new Ingestion(
        this.store,
        (message) => {
          if (!signal.aborted) notice(message);
        },
        network,
      );
      this.stopIndex = watchLibrary({ app }, this.store, (change) => {
        if (!signal.aborted) changed(change);
      });
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    const stopIndex = this.stopIndex;
    this.stopIndex = undefined;
    try {
      this.ingestion?.stop();
    } finally {
      try {
        stopIndex?.();
      } finally {
        this.store?.dispose();
      }
    }
  }
  /** Already-dispatched native writes must settle before a replacement generation starts. */
  drain(): Promise<void> {
    return this.vault?.drain() ?? Promise.resolve();
  }
}
