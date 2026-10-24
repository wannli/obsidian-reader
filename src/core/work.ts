export class SerialWrites<Key> {
  private tails = new Map<Key, Promise<unknown>>();
  busy(key: Key): boolean {
    return this.tails.has(key);
  }
  run<Result>(key: Key, write: () => Promise<Result>): Promise<Result> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(write);
    const settled = result.then(
      () => {},
      () => {},
    );
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return result;
  }
}

interface Job {
  key: string;
  promise: Promise<void>;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}
/** At most three consecutive foreground dispatches before a waiting background job. */
const FOREGROUND_BURST = 3;

/** Small session-local queue, not a second persistent job database. */
export class WorkQueue {
  private foreground: Job[] = [];
  private background: Job[] = [];
  private foregroundBurst = 0;
  private jobs = new Map<string, Job>();
  private active = 0;
  private stopped = false;
  constructor(readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid worker count.');
  }
  enqueue(key: string, run: () => Promise<void>, foreground = false): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Reader has stopped.'));
    const existing = this.jobs.get(key);
    if (existing) {
      // Only pending background work can move; active jobs keep their occupied lane.
      const index = foreground ? this.background.indexOf(existing) : -1;
      if (index !== -1) this.foreground.push(...this.background.splice(index, 1));
      return existing.promise;
    }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const result = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const job = { key, promise: result, run, resolve, reject };
    if (foreground) this.foreground.push(job);
    else this.background.push(job);
    this.jobs.set(key, job);
    this.pump();
    return result;
  }
  get pendingCount(): number {
    return this.foreground.length + this.background.length;
  }
  /** Remove only work that has not been dispatched; active work retains its slot and key. */
  cancelPending(key: string, error: unknown = new Error('Request cancelled.')): boolean {
    const job = this.jobs.get(key);
    if (!job) return false;
    for (const lane of [this.foreground, this.background]) {
      const index = lane.indexOf(job);
      if (index === -1) continue;
      lane.splice(index, 1);
      this.jobs.delete(key);
      job.reject(error);
      return true;
    }
    return false;
  }
  private pump(): void {
    while (
      !this.stopped &&
      this.active < this.concurrency &&
      (this.foreground.length || this.background.length)
    ) {
      const useForeground =
        this.foreground.length > 0 &&
        (this.background.length === 0 || this.foregroundBurst < FOREGROUND_BURST);
      const job = (useForeground ? this.foreground : this.background).shift()!;
      this.foregroundBurst = useForeground
        ? Math.min(this.foregroundBurst + 1, FOREGROUND_BURST)
        : 0;
      this.active++;
      const finished = () => {
        this.active--;
        this.jobs.delete(job.key);
        this.pump();
      };
      void Promise.resolve()
        .then(job.run)
        .then(
          () => {
            finished();
            job.resolve();
          },
          (error) => {
            finished();
            job.reject(error);
          },
        );
    }
  }
  stop(): void {
    this.stopped = true;
    for (const job of [...this.foreground.splice(0), ...this.background.splice(0)]) {
      this.jobs.delete(job.key);
      job.reject(new Error('Reader has stopped.'));
    }
  }
}
