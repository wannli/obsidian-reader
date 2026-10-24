import { requestUrl } from 'obsidian';
import type { Response } from '../content/extract';
import { WorkQueue } from '../core/work';

export class NetworkOverflowError extends Error {
  readonly retryable = true;
  constructor() {
    super('Reader network backlog is full. Retry when pending requests finish.');
    this.name = 'NetworkOverflowError';
  }
}

/** Timeouts remove waiting work, but uncancellable native requests keep their slots until settlement. */
export class Network {
  private work = new WorkQueue(2);
  private requests = new Map<
    string,
    { result: Promise<Response>; join: (guard: () => void) => void }
  >();
  private stopped = false;
  constructor(readonly maxPending = 64) {
    if (!Number.isInteger(maxPending) || maxPending < 1)
      throw new Error('Invalid network pending limit.');
  }
  readonly get = (
    url: string,
    accept: string,
    beforeRequest: () => void = () => {},
  ): Promise<Response> => {
    if (this.stopped) return Promise.reject(new Error('Reader has stopped.'));
    const key = `${accept}\n${url}`,
      cached = this.requests.get(key);
    if (cached) {
      cached.join(beforeRequest);
      return cached.result;
    }
    // Join first, even at capacity. This bounds only the network waiting backlog,
    // not ingestion/recovery work or the host's downloaded response memory.
    if (this.work.pendingCount >= this.maxPending)
      return Promise.reject(new NetworkOverflowError());
    const guards = new Set([beforeRequest]);
    let accepting = true;
    let result!: Promise<Response>;
    result = new Promise<Response>((resolve, reject) => {
      let expired = false;
      const cleanup = () => {
        clearTimeout(timer);
        accepting = false;
        guards.clear();
        // A cancelled pending request may already have a same-key retry.
        if (this.requests.get(key)?.result === result) this.requests.delete(key);
      };
      const timer = setTimeout(() => {
        expired = true;
        accepting = false;
        guards.clear();
        const error = new Error('The request timed out. Retry when the connection improves.');
        // Only pending jobs may free their key; active native I/O must keep its slot.
        if (this.work.cancelPending(key, error)) cleanup();
        reject(error);
      }, 20_000);
      void this.work
        .enqueue(key, async () => {
          if (this.stopped || expired) throw new Error('Request cancelled.');
          // Recheck at native start: timed-out requests can still occupy both
          // slots. A cancelled consumer must not cancel another valid subscriber
          // sharing this URL; each consumer also guards delivery in loadFeed.
          accepting = false;
          let cancelled: unknown;
          const allowed = [...guards].some((guard) => {
            try {
              guard();
              return true;
            } catch (error) {
              cancelled = error;
              return false;
            }
          });
          guards.clear();
          if (!allowed) throw cancelled;
          const response = await requestUrl({ url, headers: { Accept: accept }, throw: false });
          if (this.stopped || expired) throw new Error('Request cancelled.');
          resolve({ text: response.text, status: response.status, headers: response.headers });
        })
        .then(
          () => {
            cleanup();
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
    });
    this.requests.set(key, {
      result,
      join: (guard) => {
        if (accepting) guards.add(guard);
      },
    });
    return result;
  };
  stop(): void {
    this.stopped = true;
    this.work.stop();
  }
}
