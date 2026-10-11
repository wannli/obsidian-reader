#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { readBuild } from './artifacts.mjs';
import { assertRuntimeVault, connectToTestVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { integrationPath, verifyPinnedQuickAdd } from './quickadd-pin.mjs';
import { nativeQuickAddContracts } from './quickadd-contracts.mjs';
import { closeReaderViews } from './quickadd-ui.mjs';
import { verifyDummyWorker, verifyLiveTyping, verifyProtectedDuringFetch } from './quickadd-worker.mjs';
import { startRuntimeFixture } from './runtime-fixture.mjs';
import { assertDummyDefault, setDummyMode } from './runtime-modes.mjs';
import { scopedNetwork } from './runtime-network.mjs';
import { enableReader, verifyInstalledBuild } from './runtime-plugin.mjs';
import { readMarkdown } from './runtime-storage.mjs';
import { assertOwnedVault, createOnly, directory, regularFile, sandboxPath, vaultPath } from './sandbox.mjs';

if (process.argv.length !== 2) throw new Error('No arguments accepted; QuickAdd testing is restricted to the verified Reader vault');
await assertNoSafetyHold('default-vault UI/testing/restoration entrypoint');
await assertOwnedVault();
const build = await readBuild(), installed = await verifyInstalledBuild(build), quickadd = await verifyPinnedQuickAdd();
const { browser, page } = await connectToTestVault();
const fixtures = [];
let evidence, network;
const result = { status: 'running', startedAt: new Date().toISOString(), vaultPath, buildId: build.metadata.buildId, installed, quickadd,
  scope: 'Native QuickAdd Template choices/registered URI handler automatically open Reader; explicit Open Markdown permits editing; acquisition uses no manual extractor command',
  acceptance: { physicalIOS: 'NOT RUN', shortcutShareSheet: 'NOT RUN', osLevelURIRouting: 'NOT RUN', sync: 'NOT RUN' }, steps: [], pageErrors: [] };
async function screenshot(name) {
  await assertRuntimeVault(page);
  await createOnly(join(evidence, name + '.png'), await page.screenshot({ fullPage: true }));
}
try {
  await directory(join(sandboxPath, 'evidence'));
  evidence = await mkdtemp(join(sandboxPath, 'evidence', 'quickadd-runtime-'));
  await createOnly(join(evidence, 'build-meta.json'), JSON.stringify(build.metadata, null, 2) + '\n');
  page.setDefaultTimeout(15_000); page.on('pageerror', error => result.pageErrors.push(String(error.stack ?? error)));
  await page.bringToFront(); await enableReader(page, build.metadata.buildId);
  assert.equal(await page.evaluate(() => window.app.plugins.plugins.quickadd?.manifest.version), '2.32.0');
  result.defaultMode = await assertDummyDefault(page);
  await closeReaderViews(page);
  network = await scopedNetwork(page); await network.setOffline(true);
  for (const name of ['Article.md', 'Article-quick.md']) {
    assert.ok((await regularFile(join(vaultPath, 'Templates', 'Reader', name))).equals(await regularFile(join(integrationPath, name))), 'Reader must not rewrite QuickAdd template assets');
  }
  const fixture = await startRuntimeFixture(); fixtures.push(fixture);
  const captures = await nativeQuickAddContracts(page, fixture);
  result.nativeCapture = { cancellationCreatedNothing: captures.cancellationCreatedNothing, command: captures.command, uri: captures.uri,
    blank: captures.blank.path, collisions: captures.collisions.map(item => item.path), duplicateURLsCreateDistinctNotes: true };
  await screenshot('native-offline-reader');
  result.steps.push('Offline native Template command and registered URI handler created safe YAML and opened Reader; Cancel created nothing; hostile inputs stayed data; collisions did not overwrite');
  result.dummyWorker = await verifyDummyWorker(page, network, fixture, captures);
  result.requestsAtEndOfDummyMode = fixture.evidence();
  for (const [index, item] of captures.all.entries()) await createOnly(join(evidence, `dummy-capture-${index + 1}.txt`), await readMarkdown(item.path));
  await screenshot('dummy-comments-preserved');
  result.steps.push('Explicit Open Markdown stayed editable; reconnect automatically filled blank Article regions despite populated Comments; no article HTTP; complete source skipped; typed Comments preserved. RSS supplied text is a separate preservation contract.');
  const liveFixture = await startRuntimeFixture({ gateArticle: true }); fixtures.push(liveFixture);
  result.liveOptInAt = new Date().toISOString();
  result.liveWorker = await verifyLiveTyping(page, liveFixture, network);
  await createOnly(join(evidence, 'live-source-comments.txt'), result.liveWorker.markdown);
  await screenshot('live-source-comments-preserved');
  result.steps.push('No-flag native capture saved an offline pending stub and opened Reader; native Open Markdown kept its leaf/cursor; a real durable worker insertion was bracketed by individually checked native keystrokes; Comments/custom sections survived and success removed expired error/retry metadata.');
  const raceFixture = await startRuntimeFixture({ gateArticle: true }); fixtures.push(raceFixture);
  result.lateProtection = await verifyProtectedDuringFetch(page, raceFixture, build.metadata.buildId);
  await createOnly(join(evidence, 'protected-source.txt'), result.lateProtection.markdown);
  await screenshot('protected-after-inflight-fetch');
  result.steps.push('Setting the actual note protected during a gated live request vetoed its completion; protected dummy snapshot survived plugin reload byte-for-byte');
  for (const name of ['Article.md', 'Article-quick.md']) {
    assert.ok((await regularFile(join(vaultPath, 'Templates', 'Reader', name))).equals(await regularFile(join(integrationPath, name))), 'Acquisition mutated a QuickAdd template');
  }
  assert.deepEqual(result.pageErrors, []);
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = String(error.stack ?? error); result.editorRegressionFailure = error.editorRegression; process.exitCode = 1;
  if (evidence) { try { await screenshot('failure'); } catch (error) { result.screenshotError = String(error); } }
} finally {
  try {
    if (evidence) result.restoredMode = await setDummyMode(page, true);
    if (network) await network.restore();
  } catch (error) { result.status = 'failed'; result.cleanupError = String(error); process.exitCode = 1; }
  for (const fixture of fixtures) await fixture.stop();
  result.fixtures = fixtures.map(fixture => fixture.evidence()); result.finishedAt = new Date().toISOString();
  try {
    if (evidence) await createOnly(join(evidence, 'runtime.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ status: result.status, evidence, buildId: result.buildId, steps: result.steps, error: result.error, acceptance: result.acceptance }, null, 2));
  } finally { await browser.close(); }
}
