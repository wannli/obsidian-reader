import { performance } from 'node:perf_hooks';
import type { Counts } from './fs-vault';

export interface Measurement {
  name: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
  sampleMs: number[];
  operations: Counts;
}
export function difference(after: Counts, before: Counts): Counts {
  return Object.fromEntries(
    Object.keys(after).map((key) => [key, after[key] - (before[key] ?? 0)]),
  );
}
export async function measure<T>(
  name: string,
  samples: number,
  counts: () => Counts,
  action: (index: number) => T | Promise<T>,
  verify: (result: T, index: number) => void = () => {},
): Promise<Measurement> {
  const before = counts(),
    durations: number[] = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now(),
      result = await action(index);
    durations.push(performance.now() - start);
    verify(result, index); // Assertions are not part of the latency samples and do no file I/O.
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    name,
    samples,
    p50Ms: sorted[Math.ceil(samples * 0.5) - 1],
    p95Ms: sorted[Math.ceil(samples * 0.95) - 1],
    maxMs: sorted.at(-1)!,
    totalMs: durations.reduce((sum, value) => sum + value, 0),
    sampleMs: durations,
    operations: difference(counts(), before),
  };
}
