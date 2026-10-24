import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { Network, NetworkOverflowError } from '../src/host/network';
import { gate } from './helpers/memory-vault';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));
const request = vi.mocked(requestUrl);
const response = { text: 'HTML', status: 200, headers: {} };
const accept = 'text/html';
const observe = <T>(promise: Promise<T>) => promise.catch((error: unknown) => error);
const clients: Network[] = [];
const releases: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  request.mockReset();
});
afterEach(async () => {
  clients.splice(0).forEach((client) => client.stop());
  releases.splice(0).forEach((release) => release());
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});
async function stalled(limit = 64) {
  const client = new Network(limit);
  clients.push(client);
  const held = [gate(), gate()];
  held.forEach((hold) => releases.push(hold.resolve));
  let calls = 0;
  request.mockImplementation((async () => {
    const hold = held[calls++];
    if (hold) await hold.promise;
    return response;
  }) as unknown as typeof requestUrl);
  const active = [0, 1].map((i) => client.get(`https://example.com/hold-${i}`, accept));
  active.forEach((result) => void observe(result));
  await vi.advanceTimersByTimeAsync(0);
  return { client, active, held };
}

it('removes repeated expired waiting requests while both native slots remain stalled', async () => {
  const { client, active } = await stalled(2);
  // Inspect retained scheduler resources, not just the already-rejected delivery promises.
  const resources = client as unknown as {
    requests: Map<string, unknown>;
    work: { pendingCount: number };
  };
  for (let round = 0; round < 5; round++) {
    const pending = [0, 1].map((i) =>
      observe(client.get(`https://example.com/${round}-${i}`, accept)),
    );
    expect(resources.work.pendingCount).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    for (const error of await Promise.all(pending))
      expect(error).toMatchObject({ message: expect.stringContaining('timed out') });
    expect(resources.work.pendingCount).toBe(0);
    expect(resources.requests.size).toBe(2); // Only native requests remain keyed.
    expect(vi.getTimerCount()).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(client.get('https://example.com/hold-0', accept)).toBe(active[0]);
  }
});

it('does not let old queued rejection cleanup delete a synchronous same-key retry', async () => {
  const { client, held } = await stalled(1);
  const url = 'https://example.com/retry';
  const old = client.get(url, accept);
  void observe(old);
  // Run deadlines without flushing the cancellation rejection handler.
  vi.advanceTimersByTime(20_000);
  const retry = client.get(url, accept);
  void observe(retry);
  expect(retry).not.toBe(old);
  await vi.advanceTimersByTimeAsync(0);
  expect(client.get(url, accept)).toBe(retry);
  expect(vi.getTimerCount()).toBe(1);
  held[0].resolve();
  await expect(retry).resolves.toEqual(response);
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds only waiting network jobs, joins at capacity, and releases capacity on stop', async () => {
  const { client, active, held } = await stalled(2);
  const guard = vi.fn();
  const first = client.get('https://example.com/first', accept, guard);
  const second = client.get('https://example.com/second', accept);
  const outcomes = [first, second].map(observe);
  expect(client.get('https://example.com/first', accept, guard)).toBe(first);
  expect(client.get('https://example.com/hold-0', accept)).toBe(active[0]);
  const overflow = await observe(client.get('https://example.com/overflow', accept));
  expect(overflow).toBeInstanceOf(NetworkOverflowError);
  expect(overflow).toMatchObject({ retryable: true, message: expect.stringContaining('Retry') });
  expect(vi.getTimerCount()).toBe(4); // No overflow timer or native call.
  client.stop();
  client.stop();
  for (const outcome of await Promise.all(outcomes))
    expect(outcome).toMatchObject({ message: 'Reader has stopped.' });
  await expect(client.get('https://example.com/first', accept)).rejects.toThrow('stopped');
  expect(guard).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(2);
  held.forEach((hold) => hold.resolve());
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('uses a finite default ceiling of 64 pending requests without capping the two active slots', async () => {
  const { client } = await stalled();
  const waiting = Array.from({ length: 64 }, (_, i) =>
    observe(client.get(`https://example.com/wait-${i}`, accept)),
  );
  expect(await observe(client.get('https://example.com/overflow', accept))).toBeInstanceOf(
    NetworkOverflowError,
  );
  expect(vi.getTimerCount()).toBe(66);
  client.stop();
  await Promise.all(waiting);
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([0, -1, 1.5, Infinity, NaN])('rejects invalid pending ceiling %s', (limit) => {
  expect(() => new Network(limit)).toThrow('Invalid network pending limit');
});
