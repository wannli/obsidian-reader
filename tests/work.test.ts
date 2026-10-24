import { describe, expect, it, vi } from 'vitest';
import { WorkQueue } from '../src/core/work';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fixture(concurrency = 1) {
  const queue = new WorkQueue(concurrency);
  const events: string[] = [];
  function add(key: string, foreground = false) {
    const started = gate();
    const release = gate();
    const run = vi.fn(async () => {
      events.push(key);
      started.resolve();
      await release.promise;
    });
    const promise = queue.enqueue(key, run, foreground);
    return { promise, started: started.promise, release: release.resolve, run };
  }
  return { queue, events, add };
}

describe('foreground scheduling', () => {
  it('promotes pending background work to the foreground FIFO without replacing its promise or callback', async () => {
    const { queue, events, add } = fixture();
    const active = add('active');
    await active.started;
    const background = add('background');
    const promoted = add('promoted');
    const first = add('first', true);
    const replacement = vi.fn(async () => {});
    expect(queue.enqueue('promoted', replacement, true)).toBe(promoted.promise);
    const last = add('last', true);
    // Repeated promotion and a background duplicate must not reorder or demote it.
    expect(queue.enqueue('promoted', replacement, true)).toBe(promoted.promise);
    expect(queue.enqueue('promoted', replacement)).toBe(promoted.promise);
    active.release();
    for (const job of [first, promoted, last, background]) {
      await job.started;
      job.release();
    }
    await Promise.all([active, background, promoted, first, last].map((job) => job.promise));
    expect(events).toEqual(['active', 'first', 'promoted', 'last', 'background']);
    expect(promoted.run).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });

  it('keeps FIFO order within both priorities', async () => {
    const { events, add } = fixture();
    const active = add('active');
    await active.started;
    const b1 = add('b1');
    const f1 = add('f1', true);
    const b2 = add('b2');
    const f2 = add('f2', true);
    active.release();
    for (const job of [f1, f2, b1, b2]) {
      await job.started;
      job.release();
    }
    await Promise.all([active, b1, f1, b2, f2].map((job) => job.promise));
    expect(events).toEqual(['active', 'f1', 'f2', 'b1', 'b2']);
  });

  it('deduplicates dispatched and active jobs without interrupting or rerunning them', async () => {
    const { queue, events, add } = fixture(2);
    const one = add('one');
    const replacement = vi.fn(async () => {});
    // A dispatched job is active even before its callback begins.
    expect(queue.enqueue('one', replacement, true)).toBe(one.promise);
    const two = add('two');
    await Promise.all([one.started, two.started]);
    const pending = add('pending');
    expect(queue.enqueue('one', replacement, true)).toBe(one.promise);
    expect(queue.enqueue('two', replacement)).toBe(two.promise);
    expect(queue.enqueue('pending', replacement)).toBe(pending.promise);
    expect(events).toEqual(['one', 'two']);
    one.release();
    await pending.started;
    expect(events).toEqual(['one', 'two', 'pending']);
    expect(two.run).toHaveBeenCalledTimes(1);
    pending.release();
    two.release();
    await Promise.all([one.promise, two.promise, pending.promise]);
    expect(replacement).not.toHaveBeenCalled();
    expect(one.run).toHaveBeenCalledTimes(1);
    // Settlement releases the key, not just the lane.
    const again = add('one', true);
    expect(again.promise).not.toBe(one.promise);
    await again.started;
    again.release();
    await again.promise;
  });

  it('dispatches one background job after each burst of three foreground jobs', async () => {
    const { events, add } = fixture();
    const active = add('active');
    await active.started;
    const background = [add('b1'), add('b2'), add('b3')];
    const foreground = Array.from({ length: 8 }, (_, i) => add(`f${i + 1}`, true));
    active.release();
    const order = [
      ...foreground.slice(0, 3),
      background[0],
      ...foreground.slice(3, 6),
      background[1],
      ...foreground.slice(6),
      background[2],
    ];
    for (const job of order) {
      await job.started;
      job.release();
    }
    await Promise.all([active, ...order].map((job) => job.promise));
    expect(events).toEqual([
      'active',
      'f1',
      'f2',
      'f3',
      'b1',
      'f4',
      'f5',
      'f6',
      'b2',
      'f7',
      'f8',
      'b3',
    ]);
  });

  it.each(['throw', 'reject'] as const)(
    'releases a lane and key after a callback %s',
    async (failure) => {
      const { queue, add } = fixture();
      const entered = gate();
      const release = gate();
      const error = new Error('failed');
      const failed = queue.enqueue('failed', () => {
        entered.resolve();
        if (failure === 'throw') throw error;
        return release.promise.then(() => Promise.reject(error));
      });
      const rejected = expect(failed).rejects.toBe(error);
      const next = add('next', true);
      await entered.promise;
      release.resolve();
      await rejected;
      await next.started;
      const retry = add('failed');
      next.release();
      await retry.started;
      retry.release();
      await Promise.all([next.promise, retry.promise]);
    },
  );

  it('stops both pending priorities but leaves active lanes occupied until settlement', async () => {
    const { queue, events, add } = fixture(2);
    const active = add('active');
    const failing = add('also-active');
    await Promise.all([active.started, failing.started]);
    const background = add('background');
    const promoted = add('promoted');
    const foreground = add('foreground', true);
    expect(queue.enqueue('promoted', async () => {}, true)).toBe(promoted.promise);
    const rejected = [background, promoted, foreground].map((job) =>
      expect(job.promise).rejects.toThrow('Reader has stopped.'),
    );
    let settled = false;
    void active.promise.then(() => {
      settled = true;
    });
    queue.stop();
    queue.stop();
    await Promise.all(rejected);
    expect(settled).toBe(false);
    expect(events).toEqual(['active', 'also-active']);
    const replacement = vi.fn(async () => {});
    await expect(queue.enqueue('active', replacement, true)).rejects.toThrow('Reader has stopped.');
    await expect(queue.enqueue('new', replacement)).rejects.toThrow('Reader has stopped.');
    active.release();
    failing.release();
    await Promise.all([active.promise, failing.promise]);
    expect(events).toEqual(['active', 'also-active']);
    expect(replacement).not.toHaveBeenCalled();
  });

  it('preserves an active failure after stop without dispatching pending work', async () => {
    const queue = new WorkQueue(1);
    const started = gate();
    const release = gate();
    const error = new Error('active failure');
    const active = queue.enqueue('active', async () => {
      started.resolve();
      await release.promise;
      throw error;
    });
    const rejected = expect(active).rejects.toBe(error);
    await started.promise;
    const run = vi.fn(async () => {});
    const pending = expect(queue.enqueue('pending', run, true)).rejects.toThrow(
      'Reader has stopped.',
    );
    queue.stop();
    await pending;
    release.resolve();
    await rejected;
    expect(run).not.toHaveBeenCalled();
  });
});
