#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

/** Bundle pure production analysis in memory. Counters do not alter runtime sources. */
export async function analysisRunner() {
  const result = await build({
    stdin: {
      contents: `export { readDocument } from './src/core/document';
      export { blockSpans, renderedHighlight } from './src/core/markdown';
      export { passages, hasAnnotations } from './src/core/annotations';
      export { ArticleAnalysis } from './src/reader/article-analysis';
      export { counts } from 'reader-analysis-counts';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [
      {
        name: 'analysis-counters',
        setup(builder) {
          builder.onResolve({ filter: /^reader-analysis-counts$/ }, () => ({
            path: 'counts',
            namespace: 'analysis',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'analysis' }, () => ({
            contents: 'export const counts = { block: 0, inline: 0, yaml: 0 };',
          }));
          builder.onLoad(
            { filter: /\/core\/(markdown|annotations|document)\.ts$/ },
            async ({ path }) => {
              const source = ts.createSourceFile(
                path,
                await readFile(path, 'utf8'),
                ts.ScriptTarget.Latest,
                true,
              );
              const transformed = ts.transform(source, [
                (context) => {
                  const visit = (node) => {
                    const next = ts.visitEachChild(node, visit, context);
                    if (!ts.isCallExpression(node)) return next;
                    const key = {
                      'Lexer.lex': 'block',
                      'Lexer.lexInline': 'inline',
                      parseDocument: 'yaml',
                    }[node.expression.getText(source)];
                    return key
                      ? ts.factory.createParenthesizedExpression(
                          ts.factory.createCommaListExpression([
                            ts.factory.createPostfixIncrement(
                              ts.factory.createPropertyAccessExpression(
                                ts.factory.createIdentifier('__readerParseCounts'),
                                key,
                              ),
                            ),
                            next,
                          ]),
                        )
                      : next;
                  };
                  return (root) => ts.visitNode(root, visit);
                },
              ]);
              try {
                return {
                  contents:
                    `import { counts as __readerParseCounts } from 'reader-analysis-counts';\n` +
                    ts.createPrinter().printFile(transformed.transformed[0]),
                  loader: 'ts',
                };
              } finally {
                transformed.dispose();
              }
            },
          );
        },
      },
    ],
  });
  return import(
    'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
  );
}

export function syntheticArticle(targetBytes) {
  const paragraph =
    'A synthetic paragraph with **bold words**, a [publisher link](https://example.invalid/story), ==highlighted words== (※ [[Notes/Synthetic]]) and `literal code`.\n\n';
  const body =
    '# Synthetic article\n\n' + paragraph.repeat(Math.ceil(targetBytes / paragraph.length));
  return {
    body,
    raw:
      '---\ntitle: Synthetic article\nurl: https://example.invalid/story\nstatus: Later\ntopics: [Synthetic]\n---\n' +
      body,
  };
}

export function measure(action, counts, { warmup = 3, samples = 9 } = {}) {
  assert.ok(Number.isSafeInteger(warmup) && warmup >= 0);
  assert.ok(Number.isSafeInteger(samples) && samples > 0);
  for (let i = 0; i < warmup; i++) action();
  for (const key of Object.keys(counts)) counts[key] = 0;
  const times = [];
  let checksum = 0;
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    checksum += Number(action());
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return {
    samples,
    medianMs: times[Math.floor(times.length / 2)],
    p95Ms: times[Math.ceil(times.length * 0.95) - 1],
    parseCounts: { ...counts },
    checksum,
  };
}

export async function benchmarkAnalysis(options = {}) {
  const api = await analysisRunner();
  const cases = [];
  for (const bytes of [2_048, 16_384, 65_536]) {
    const { body, raw } = syntheticArticle(bytes);
    assert.equal(api.readDocument(raw).body, body);
    const cached = new api.ArticleAnalysis();
    const stages = {
      document: () => Object.keys(api.readDocument(raw).properties).length,
      blocks: () => api.blockSpans(body).paragraphs.length,
      passages: () => api.passages(body).length,
      retention: () => Number(api.hasAnnotations(body, {})),
      renderedHighlight: () => Number(api.renderedHighlight(body)),
      repeatedPassages: () =>
        api.passages(body).length + api.passages(body).length + api.passages(body).length,
      cachedRepeatedPassages: () => {
        const analysis = new api.ArticleAnalysis();
        return (
          analysis.passages(body).length +
          analysis.passages(body).length +
          analysis.passages(body).length
        );
      },
      warmCachedPassages: () => cached.passages(body).length,
    };
    cases.push({
      bodyBytes: Buffer.byteLength(body),
      stages: Object.fromEntries(
        Object.entries(stages).map(([name, action]) => [
          name,
          measure(action, api.counts, options),
        ]),
      ),
    });
  }
  return {
    node: process.version,
    source: 'in-memory synthetic Markdown; instrumented production parsers',
    limitations: [
      'Warm algorithm timings, not cold disk, native rendering, mobile/device latency, or E2E acceptance.',
      'Repeated-passages stage models three same-body UI lookups, not a claim that every interaction makes three calls.',
      'No vault, network, runtime installation, corpus files, or wall-clock assertions. Parse counters cover explicit core Lexer.lex, Lexer.lexInline and YAML parseDocument calls.',
    ],
    cases,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await benchmarkAnalysis(), null, 2));
