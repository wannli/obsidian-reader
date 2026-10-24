# Article analysis profile

Run `mise exec -- npm run benchmark:analysis` from the repository root. This opt-in benchmark uses only generated in-memory Markdown and bundled production analysis. It does not open a vault, use the network, install a plugin or write a corpus.

## Measurement

The benchmark separates YAML document parsing, block analysis, passage extraction, retention detection and rendered-highlight detection. Each stage has 3 warmup calls and 9 measured calls. Results include median/p95 milliseconds and explicit core block, inline and YAML parser-call counts. Counters are injected only into the in-memory benchmark bundle; runtime sources are not instrumented.

One local run produced these medians:

| Synthetic body | One passage lookup | 3 uncached lookups | 3 lookups, 1 fresh cache | Warm cached lookup |
| -------------- | -----------------: | -----------------: | -----------------------: | -----------------: |
| 2,140 bytes    |            1.04 ms |            2.58 ms |                  0.82 ms |           0.002 ms |
| 16,647 bytes   |            7.06 ms |           19.83 ms |                  6.98 ms |           0.007 ms |
| 66,525 bytes   |           35.88 ms |          110.09 ms |                 37.22 ms |           0.030 ms |

The 3-lookups stage models repeated same-body UI queries, not a claim that every interaction makes 3 calls. For the largest body, 9 measured repetitions required 27 block/11,016 inline parser calls without reuse, versus 9 block/3,672 inline calls with one fresh cache per repetition. Warm cache hits required no parser calls. Document parsing remained below 0.2 ms in these fixtures; YAML caching was not justified.

## Bounded optimization

`reader/article-analysis.ts` stores only passage analysis for one exact body string. Each `ReadingSurface` owns its instance and clears it on disposal. Rendering and view actions share that instance. A different body replaces the entry even when its length and file stats are unchanged. Returning to an earlier body reparses it; there is no history or vault-wide map.

Every lookup returns independent passage objects, host arrays, fragment spans and citation spans. A mutable UI intent cannot alter cached evidence. Failed parsing does not publish a new key. No YAML document, parser AST, DOM node or file metadata is cached.

This cache does not authorize mutations. Existing raw-byte/file-identity/dirty-editor checks, displayed-body checks, article generations and hosted completion phases remain authoritative. Analysis is a pure function of body text, so metadata-only changes do not invalidate its meaning.

## Limits and validation

- These are warm, instrumented, synthetic algorithm timings, not cold disk, native rendering, Obsidian/mobile latency, device acceptance or E2E results.
- Runtime and tooling tests check exact-revision replacement, one-entry retention, nested mutation isolation, failure recovery and parse-call reduction. CI has no wall-clock assertions.
- Existing rendering, selection, deferred-body, hosted-highlight and generation-race suites remain in the full check.
- Rerun the benchmark for comparisons; timing differences between stages include normal JIT/GC noise. No fixed latency guarantee follows from this run.
