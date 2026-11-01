import { CacheState } from './fileclass-cache-state';
import { readCatalog } from './fileclass-cache-signature';
import type { PublicApi } from './fileclass-fields';

/** One serial worker for catalog reads, full snapshots, and incremental explanations. */
export class CacheWork extends CacheState {
  protected running?: Promise<void>;

  protected pump(): Promise<void> {
    if (this.running) return this.running;
    // Install the promise before starting work (including synchronous event reentrancy).
    const work = Promise.resolve().then(async () => {
      try {
        await this.drain();
      } finally {
        if (this.running === work) this.running = undefined;
      }
      // Include work queued in the final async continuation in explicit refresh's await.
      if (this.live && this.connection && this.pending()) await this.pump();
    });
    this.running = work;
    return work;
  }
  private pending(): boolean {
    return this.fullWanted || this.indexedWanted || (this.dirtyReady && !!this.dirty.size);
  }
  private async drain(): Promise<void> {
    while (this.live && this.connection && this.pending()) {
      const token = this.connection,
        epoch = this.epoch;
      const check = (): void => this.check(token, epoch);
      try {
        check();
        if (this.fullWanted) await this.full(token, check);
        else if (this.indexedWanted) await this.inspect(token, check);
        else await this.patch(check);
      } catch {
        if (!this.live || epoch !== this.epoch) continue;
        const raw = this.raw();
        // Do not retry a broken source every health tick: retry only on identity change or refresh.
        this.reset(raw, raw === token);
      }
    }
  }
  private async full(token: PublicApi, check: () => void): Promise<void> {
    this.fullWanted = false;
    this.idleWanted = false; // Later ambiguous events must survive this in-flight snapshot.
    this.building = true;
    this.buildingToken = token;
    const signal = this.cancellation.signal;
    try {
      const catalog = this.prepared ?? (await readCatalog(token, check));
      this.prepared = undefined;
      check();
      let sourceFailed = false;
      // Supplying the source pins its abort signal; NodeIndex may swallow source errors.
      const swapped = await this.index.rebuild(async () => {
        check();
        try {
          return await this.backend.members(signal);
        } catch (error) {
          sourceFailed = true;
          throw error;
        }
      });
      check();
      if (sourceFailed) throw new Error('Fileclass membership snapshot failed');
      if (swapped === false)
        this.fullWanted = true; // Only clear/dispose/new rebuild supersedes a snapshot.
      else {
        this.publish(catalog);
        this.lastFull = Date.now();
      }
      this.dirtyReady = true; // Replay buffered note explanations after the snapshot and overlays swap.
    } finally {
      this.building = false;
      this.buildingToken = undefined;
    }
  }
  private async inspect(token: PublicApi, check: () => void): Promise<void> {
    this.indexedWanted = false;
    const unknown = this.unknownIndexed;
    this.unknownIndexed = false;
    const catalog = await readCatalog(token, check);
    check();
    if (catalog.signature !== this.signature || unknown) {
      this.prepared = catalog;
      this.fullWanted = true;
    } else this.replayRecent();
  }
  private async patch(check: () => void): Promise<void> {
    let count = 0;
    while (this.dirtyReady && this.dirty.size && !this.fullWanted && !this.indexedWanted) {
      const [path, request] = this.dirty.entries().next().value!;
      this.dirty.delete(path);
      const { file, revision } = request;
      const current = (): boolean =>
        this.revisions.get(path) === revision && this.current(file, path);
      try {
        check();
        if (!current()) continue;
        const classes = await this.backend.classesFor(path);
        check();
        if (current()) {
          if (classes.length) this.index.remember(file, classes);
          else this.index.forget(path);
        }
      } catch (error) {
        check();
        // Deletion/rename/replacement can make an otherwise valid public read reject.
        if (current()) throw error;
      } finally {
        if (this.revisions.get(path) === revision) this.revisions.delete(path);
      }
      if (++count % 40 === 0 && this.dirty.size) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        check();
      }
    }
    if (!this.dirty.size) this.dirtyReady = false;
  }
}
