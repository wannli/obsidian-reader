#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, platform, release, arch, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
import { build } from 'esbuild';
import { assertNoSafetyHold } from './safety-hold.mjs';
import {
  assertOwnedVault,
  assertSafePath,
  createOnly,
  directory,
  inside,
  isMain,
  regularFile,
  repository,
  runtimeTarget,
  sandboxPath,
  vaultPath,
} from './sandbox.mjs';

export const corpusMarkerName = '.reader-scale-corpus.json';
const purpose = 'Reader isolated offline scale benchmark';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Pure location/marker validation; creation still requires the fixed-vault guards below.
export function validateCorpusLocation(root, selectedVault = vaultPath) {
  root = resolve(root);
  assert.equal(
    dirname(root),
    join(selectedVault, '.reader-benchmarks'),
    'Corpus must be a direct hidden child of the selected vault',
  );
  assert.match(basename(root), /^run-[A-Za-z0-9_-]+$/, 'Invalid corpus directory');
  return root;
}
export function validateCorpusMarker(actual, expected) {
  assert.equal(actual?.schemaVersion, 1);
  assert.equal(actual?.purpose, purpose);
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(actual[key], value, `Corpus marker mismatch: ${key}`);
}
function forbidNetwork() {
  let attempts = 0;
  const blocked = () => {
    attempts++;
    throw new Error('Live network is forbidden in the scale benchmark');
  };
  for (const [object, keys] of [
    [http, ['request', 'get']],
    [https, ['request', 'get']],
    [net, ['connect', 'createConnection']],
    [tls, ['connect']],
    [http2, ['connect']],
  ]) {
    for (const key of keys) object[key] = blocked;
  }
  globalThis.fetch = blocked;
  globalThis.WebSocket = blocked;
  syncBuiltinESMExports();
  return { blocked, attempts: () => attempts };
}
async function installDom(blocked) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://reader-scale.invalid/',
  });
  for (const name of [
    'window',
    'document',
    'navigator',
    'DOMParser',
    'Node',
    'NodeFilter',
    'Element',
    'HTMLElement',
    'Document',
    'DocumentFragment',
    'HTMLTemplateElement',
    'HTMLImageElement',
    'HTMLAnchorElement',
    'XMLSerializer',
  ]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? dom.window : dom.window[name],
    });
  }
  dom.window.fetch = blocked;
  dom.window.XMLHttpRequest = blocked;
  dom.window.WebSocket = blocked;
  return dom;
}

export async function benchmarkScale({ feeds = true } = {}) {
  const began = performance.now(),
    now = new Date().toISOString();
  await assertNoSafetyHold('offline scale benchmark');
  await assertOwnedVault(); // Validate an EXISTING fixed vault; never bootstrap/adopt a vault.
  const preflightMs = performance.now() - began;
  const parent = join(vaultPath, '.reader-benchmarks');
  await directory(parent);
  const root = validateCorpusLocation(await mkdtemp(join(parent, 'run-')));
  await assertSafePath(root, 'directory');
  const marker = {
    schemaVersion: 1,
    purpose,
    repository,
    vaultPath,
    corpusPath: root,
    id: randomUUID(),
    createdAt: now,
    articles: 10_000,
    feeds: 100,
    articleBodyBytes: 10 * 1024,
  };
  assert(
    await createOnly(join(root, corpusMarkerName), `${JSON.stringify(marker, null, 2)}\n`),
    'Refusing existing corpus marker',
  );
  const verifyMarker = async () => {
    validateCorpusLocation(root);
    validateCorpusMarker(JSON.parse(await regularFile(join(root, corpusMarkerName))), marker);
  };
  await verifyMarker();
  const guard = async (path, kind) => {
    inside(root, path);
    await assertNoSafetyHold('offline scale corpus I/O');
    await assertSafePath(path, kind);
  };
  const evidenceDirectory = join(sandboxPath, 'evidence');
  await directory(evidenceDirectory);
  const evidence = join(evidenceDirectory, `scale-${now.replace(/[:.]/g, '-')}-${marker.id}.json`);
  const result = {
    schemaVersion: 1,
    status: 'running',
    startedAt: now,
    corpusPath: root,
    evidencePath: evidence,
    target: runtimeTarget,
    environment: {
      node: process.version,
      execPath: process.execPath,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    preflightMs,
    limitations: [
      'Real Markdown files and real Catalog/ArticleStore; benchmark-only guarded filesystem port.',
      'OS file cache is explicitly warmed by corpus generation/metadata preparation. First means first algorithm invocation, NOT cold disk.',
      'No native rendering, Obsidian metadata-cache construction, editor synchronization, native backlink rewrite, device latency, or E2E claims.',
      'Writes are OS-buffered, not fsync durability timings. Moves use exclusive hard-link/unlink inside the corpus, not native Obsidian rename.',
      'I/O counters cover Markdown payload reads/writes; pathGuards count safety checks. Guard lstat/marker/preflight overhead is not Markdown payload I/O.',
      'No-op process callbacks read but do not physically rewrite unchanged files in this benchmark port.',
      'The hidden corpus and temporary runner are retained; no other data is cleaned up.',
    ],
  };
  const network = forbidNetwork();
  let dom, context;
  try {
    const buildStart = performance.now();
    const runner = await mkdtemp(join(sandboxPath, '.scale-runner-'));
    await assertSafePath(runner, 'directory');
    const bundled = await build({
      absWorkingDir: repository,
      entryPoints: { core: 'tests/benchmarks/scale.ts', feeds: 'tests/benchmarks/feeds.ts' },
      outdir: runner,
      outExtension: { '.js': '.mjs' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      packages: 'external',
      write: false,
      metafile: true,
      logLevel: 'silent',
      alias: {
        obsidian: join(repository, 'tests/benchmarks/obsidian-stub.ts'),
        // Bundle this CommonJS dependency like the plugin build: Node's native ESM
        // import does not expose its createMarkdownContent property as a named export.
        'defuddle/full': createRequire(import.meta.url).resolve('defuddle/full'),
      },
    });
    assert(
      !Object.values(bundled.metafile.outputs).some((output) =>
        output.imports.some(
          (item) => item.external && ['obsidian', 'defuddle/full'].includes(item.path),
        ),
      ),
    );
    const artifacts = {};
    for (const output of bundled.outputFiles) {
      inside(runner, output.path);
      assert(await createOnly(output.path, output.contents));
      artifacts[basename(output.path)] = hash(output.contents);
    }
    const sources = {};
    for (const path of Object.keys(bundled.metafile.inputs))
      sources[path] = hash(await readFile(resolve(repository, path)));
    result.runner = { path: runner, buildMs: performance.now() - buildStart, artifacts, sources };
    const core = await import(pathToFileURL(join(runner, 'core.mjs')).href);
    context = await core.runCore({
      root,
      guard,
      now,
      log: (message) => console.log(`[scale] ${message}`),
    });
    Object.assign(result, context.result);
    await verifyMarker();
    if (feeds) {
      console.log(
        '[scale] Running 100-feed refresh with real ingestion/content and an allowlisted in-process transport',
      );
      const domStart = performance.now();
      dom = await installDom(network.blocked);
      const feedModule = await import(pathToFileURL(join(runner, 'feeds.mjs')).href);
      result.feedModuleSetupMs = performance.now() - domStart;
      result.feedRefresh = await feedModule.runFeeds(context, now);
    } else result.feedRefresh = { status: 'not-run', addedArticles: 0, reason: '--core-only' };
    await verifyMarker();
    result.verification = await core.verifyFinal(context, result.feedRefresh.addedArticles);
    result.totalPortOperations = context.port.counts();
    assert.equal(network.attempts(), 0, 'Live network was attempted');
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = { message: String(error), stack: error?.stack };
    process.exitCode = 1;
  } finally {
    context?.store.dispose();
    dom?.window.close();
    result.liveNetworkAttempts = network.attempts();
    result.elapsedMs = performance.now() - began;
    result.memory = { ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS };
    assert(
      await createOnly(evidence, `${JSON.stringify(result, null, 2)}\n`),
      'Refusing existing evidence file',
    );
    const measurements = [
      ...(result.measurements ?? []),
      ...(result.feedRefresh?.measurements ?? []),
    ];
    console.table(
      measurements.map((row) => ({
        phase: row.name,
        n: row.samples,
        p50_ms: +row.p50Ms.toFixed(3),
        p95_ms: +row.p95Ms.toFixed(3),
        max_ms: +row.maxMs.toFixed(3),
        reads: row.operations.reads,
        writes: row.operations.writes,
        moves: row.operations.moves,
      })),
    );
    console.log(
      JSON.stringify(
        {
          status: result.status,
          corpus: root,
          evidence,
          initialArticles: result.dataset?.initialArticles,
          finalArticles: result.verification?.finalArticles,
          liveNetworkAttempts: result.liveNetworkAttempts,
          elapsedMs: result.elapsedMs,
          error: result.error,
        },
        null,
        2,
      ),
    );
  }
  return result;
}

if (isMain(import.meta.url)) {
  if (
    process.argv.slice(2).some((argument) => argument !== '--core-only') ||
    process.argv.length > 3
  )
    throw new Error('Usage: node scripts/benchmark-scale.mjs [--core-only]');
  await benchmarkScale({ feeds: !process.argv.includes('--core-only') });
}
