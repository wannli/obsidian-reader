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
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}
/** Small session-local queue, not a second persistent job database. */
export class WorkQueue {
  private pending: Job[] = [];
  private jobs = new Map<string, Promise<void>>();
  private active = 0;
  private stopped = false;
  constructor(readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid worker count.');
  }
  enqueue(key: string, run: () => Promise<void>, foreground = false): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Reader has stopped.'));
    const existing = this.jobs.get(key);
    if (existing) return existing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const result = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const job = { key, run, resolve, reject };
    if (foreground) this.pending.unshift(job);
    else this.pending.push(job);
    this.jobs.set(key, result);
    this.pump();
    return result;
  }
  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
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
    for (const job of this.pending.splice(0)) {
      this.jobs.delete(job.key);
      job.reject(new Error('Reader has stopped.'));
    }
  }
}
