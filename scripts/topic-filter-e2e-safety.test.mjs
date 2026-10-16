import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { sandboxPath, directory } from './sandbox.mjs';
import { ownBrowserOutput, writeBrowserOutput } from './topic-filter-e2e-safety.mjs';

test('browser output rejects unowned/mismatched directories and symlink outputs', async () => {
  await directory(sandboxPath);
  const temp = await mkdtemp(path.join(sandboxPath, 'topic-filter-e2e-safety-'));
  try {
    const unmarked = path.join(temp, 'unmarked');
    await directory(unmarked);
    await writeFile(path.join(unmarked, 'existing'), 'keep');
    await assert.rejects(ownBrowserOutput(unmarked, temp), /unmarked/);
    const owned = path.join(temp, 'owned');
    await ownBrowserOutput(owned, temp);
    await ownBrowserOutput(owned, temp);
    await assert.rejects(ownBrowserOutput(owned, 'wrong'), /ownership/);
    const target = path.join(temp, 'target');
    await writeFile(target, 'keep');
    const link = path.join(owned, 'harness.js');
    await symlink(target, link);
    await assert.rejects(writeBrowserOutput(link, 'unsafe'), /symlink/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
