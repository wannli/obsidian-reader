#!/usr/bin/env node
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { readBuild } from './artifacts.mjs';
import { assertRuntimeVault, connectToTestVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { setDummyMode } from './runtime-modes.mjs';
import { verifyInstalledBuild, verifyReader } from './runtime-plugin.mjs';
import { commandReader, openArticle } from './runtime-ui.mjs';
import { seedTitle } from './seed.mjs';
import { assertOwnedVault, createOnly, directory, sandboxPath, vaultPath } from './sandbox.mjs';

if (process.argv.length !== 2) throw new Error('Only the fixed marked Reader test vault is allowed');
await assertNoSafetyHold('default-vault UI/testing/restoration entrypoint');
await assertOwnedVault();
const build = await readBuild(), installed = await verifyInstalledBuild(build);
const { browser, page } = await connectToTestVault();
try {
  await assertRuntimeVault(page);
  const runtime = await verifyReader(page, build.metadata.buildId);
  const mode = await setDummyMode(page, true);
  await page.bringToFront(); await commandReader(page); await openArticle(page, seedTitle);
  await directory(join(sandboxPath, 'evidence'));
  const evidence = await mkdtemp(join(sandboxPath, 'evidence', 'reader-demo-'));
  await createOnly(join(evidence, 'quiet-room.png'), await page.screenshot({ fullPage: true }));
  const result = { status: 'opened', vaultPath, buildId: runtime.buildId, installed, useDummyContent: mode.current, evidence,
    scope: 'Verified test-vault foreground/Reader-view action only; not a full QA pass' };
  await createOnly(join(evidence, 'demo.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
