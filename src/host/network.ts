import { requestUrl } from 'obsidian';
import type { Response } from '../content/extract';
import { WorkQueue } from '../core/work';

/** Timeouts stop delivery, not the host's uncancellable request. Its slot stays occupied until it ends. */
export class Network {
  private work = new WorkQueue(2);
  private requests = new Map<
    string,
    { result: Promise<Response>; join: (guard: () => void) => void }
  >();
  private stopped = false;
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
    const guards = new Set([beforeRequest]);
    let accepting = true;
    let result!: Promise<Response>;
    result = new Promise<Response>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        accepting = false;
        guards.clear();
        reject(new Error('The request timed out. Retry when the connection improves.'));
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
            clearTimeout(timer);
            this.requests.delete(key);
          },
          (error) => {
            clearTimeout(timer);
            this.requests.delete(key);
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
