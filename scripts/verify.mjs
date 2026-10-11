#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readBuild, sha256 } from './artifacts.mjs';
import { acceptanceMatrix } from './acceptance-matrix.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { createOnly, directory, regularFile, repository, sandboxPath } from './sandbox.mjs';

const staticOnly = process.argv.length === 3 && process.argv[2] === '--static-only';
if (process.argv.length !== 2 && !staticOnly) throw new Error('Only --static-only is accepted; all commands and test-vault targets are fixed');
if (!staticOnly) await assertNoSafetyHold('full default-vault verification/cleanup workflow');
const evidenceRoot = join(sandboxPath, 'evidence');
await directory(evidenceRoot);
const evidence = await mkdtemp(join(evidenceRoot, 'verification-'));
let runtimeStarted = false;
const result = { status: 'running', startedAt: new Date().toISOString(), evidence, checks: [], requirements: acceptanceMatrix(), acceptanceComplete: false,
  acceptance: { physicalIOS: 'NOT RUN', nativeTouchSelection: 'NOT RUN', sync: 'NOT RUN' } };

async function sourceSnapshot() {
  const hashes = {};
  async function collect(relative) {
    for (const item of await readdir(join(repository, relative), { withFileTypes: true })) {
      const name = `${relative}/${item.name}`;
      if (item.isSymbolicLink()) throw new Error(`Refusing symlinked verification source: ${name}`);
      if (item.isDirectory()) await collect(name);
      else hashes[name] = sha256(await regularFile(join(repository, name)));
    }
  }
  for (const folder of ['src', 'tests', 'scripts', 'integrations']) await collect(folder);
  for (const name of ['package.json', 'package-lock.json', 'manifest.json', 'styles.css', 'tsconfig.json', 'vitest.config.ts']) {
    hashes[name] = sha256(await regularFile(join(repository, name)));
  }
  return hashes;
}
async function run(name, executable, args) {
  console.log(`\n--- ${name}: ${executable} ${args.join(' ')} ---`);
  const startedAt = new Date().toISOString();
  const command = spawnSync(executable, args, { cwd: repository, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
  const output = `${command.stdout ?? ''}${command.stderr ?? ''}${command.error ? '\n' + command.error.stack : ''}`;
  process.stdout.write(output);
  const log = `${name}.txt`;
  await createOnly(join(evidence, log), output);
  result.checks.push({ name, command: [executable, ...args], status: command.status === 0 ? 'passed' : 'failed',
    startedAt, finishedAt: new Date().toISOString(), exitCode: command.status, signal: command.signal, log });
  if (command.status !== 0) throw new Error(`${name} failed; see ${join(evidence, log)}`);
  return output;
}

try {
  result.sources = await sourceSnapshot();
  await run('typecheck', 'npm', ['run', 'typecheck']);
  await run('unit', 'npm', ['test']);
  await run('tooling', process.execPath, ['--test', 'scripts/tooling.test.mjs', 'scripts/editor-regression.test.mjs', 'scripts/safety-hold.test.mjs', 'scripts/session-regression.test.mjs', 'scripts/paused-install.test.mjs']);
  await run('build', 'npm', ['run', 'build']);
  const build = await readBuild();
  result.buildId = build.metadata.buildId;
  await createOnly(join(evidence, 'build-meta.json'), `${JSON.stringify(build.metadata, null, 2)}\n`);
  if (!staticOnly) {
    runtimeStarted = true;
    await run('vault-setup', 'npm', ['run', 'vault:setup']);
    await run('vault-open', 'npm', ['run', 'vault:open']);
    await run('quickadd-install', process.execPath, ['scripts/setup-quickadd.mjs']);
    await run('vault-safe-update', process.execPath, ['scripts/update-runtime.mjs']);
    const runtimeOutput = await run('obsidian', 'npm', ['run', 'test:obsidian']);
    result.runtimeEvidence = /"evidence":\s*"([^"]+)"/.exec(runtimeOutput)?.[1];
    const quickaddOutput = await run('quickadd-runtime', process.execPath, ['scripts/test-quickadd.mjs']);
    result.quickaddEvidence = /"evidence":\s*"([^"]+)"/.exec(quickaddOutput)?.[1];
    await run('demo-default-mode', process.execPath, ['scripts/show-reader.mjs']);
  }
  assert.deepEqual(await sourceSnapshot(), result.sources, 'Sources changed during final verification; the results must not be represented as current');
  assert.equal((await readBuild()).metadata.buildId, result.buildId, 'Bundle changed during final verification');
  result.status = staticOnly ? 'static-passed' : 'covered-cases-passed-with-gaps';
  if (staticOnly) result.runtime = 'NOT RUN in this sweep; no Obsidian UI or settings actions performed';
  else {
    result.remainingAcceptance = 'Current harness cases passed, but the canonical requirement matrix is not yet fully evidenced; do not report complete delivery.';
    process.exitCode = 1;
  }
} catch (error) {
  result.status = 'failed';
  result.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (runtimeStarted) {
    try { await run('restore-default-mode', process.execPath, ['scripts/restore-runtime.mjs']); }
    catch (error) { result.status = 'failed'; result.cleanupError = String(error); process.exitCode = 1; }
  }
  result.finishedAt = new Date().toISOString();
  await createOnly(join(evidence, 'verification.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.status, evidence, buildId: result.buildId, runtimeEvidence: result.runtimeEvidence, quickaddEvidence: result.quickaddEvidence, runtime: result.runtime,
    checks: result.checks.map(({ name, status }) => ({ name, status })), error: result.error, cleanupError: result.cleanupError,
    acceptanceComplete: result.acceptanceComplete, remainingAcceptance: result.remainingAcceptance, acceptance: result.acceptance }, null, 2));
}
