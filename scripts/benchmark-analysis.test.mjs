import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisRunner, measure, syntheticArticle } from './benchmark-analysis.mjs';

test('analysis corpus is deterministic in-memory Markdown with existing-schema properties', () => {
  const article = syntheticArticle(2048);
  assert.deepEqual(article, syntheticArticle(2048));
  assert.ok(Buffer.byteLength(article.body) >= 2048);
  assert.ok(article.raw.endsWith(article.body));
  assert.match(article.body, /==highlighted words==/);
  assert.match(article.body, /\[\[Notes\/Synthetic\]\]/);
});
test('analysis measurements exclude warmup counts and do not assert wall-clock limits', () => {
  const counts = { block: 0 };
  let calls = 0;
  const result = measure(
    () => {
      calls++;
      counts.block++;
      return 2;
    },
    counts,
    { warmup: 1, samples: 3 },
  );
  assert.equal(calls, 4);
  assert.equal(result.samples, 3);
  assert.equal(result.checksum, 6);
  assert.deepEqual(result.parseCounts, { block: 3 });
  assert.equal(Number.isFinite(result.medianMs), true);
  assert.throws(() => measure(() => 1, counts, { samples: 0 }));
  assert.throws(() => measure(() => 1, counts, { warmup: -1 }));
});
test('instrumented production parsers show one exact-revision parse instead of three', async () => {
  const api = await analysisRunner(),
    { body, raw } = syntheticArticle(512);
  api.counts.block = api.counts.inline = api.counts.yaml = 0;
  assert.equal(api.readDocument(raw).body, body);
  assert.deepEqual(api.counts, { block: 0, inline: 0, yaml: 1 });
  const baseline = measure(
    () => api.passages(body).length + api.passages(body).length + api.passages(body).length,
    api.counts,
    { warmup: 0, samples: 1 },
  );
  const cached = measure(
    () => {
      const analysis = new api.ArticleAnalysis();
      return (
        analysis.passages(body).length +
        analysis.passages(body).length +
        analysis.passages(body).length
      );
    },
    api.counts,
    { warmup: 0, samples: 1 },
  );
  assert.equal(cached.checksum, baseline.checksum);
  assert.equal(baseline.parseCounts.block, 3);
  assert.equal(cached.parseCounts.block, 1);
  assert.ok(cached.parseCounts.inline > 0);
  assert.equal(baseline.parseCounts.inline, cached.parseCounts.inline * 3);
  const analysis = new api.ArticleAnalysis();
  analysis.passages(body);
  const hit = measure(() => analysis.passages(body).length, api.counts, { warmup: 0, samples: 1 });
  assert.deepEqual(hit.parseCounts, { block: 0, inline: 0, yaml: 0 });
});
