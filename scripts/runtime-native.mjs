import assert from 'node:assert/strict';
import { assertRuntimeVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { pluginId, vaultPath } from './sandbox.mjs';

// IDs from src/ui/commands.ts, not labels or obsolete in-view controls.
export const nativeCommands = Object.freeze(['open-reader', 'reading-list', 'switch-queue', 'previous', 'next', 'open-markdown',
  'original', 'assign-topics', 'capture-url', 'rss-feeds', 'move-to-inbox', 'move-to-later', 'move-to-archive', 'fetch-full-text']);

export async function nativeReaderCommand(page, suffix) {
  await assertNoSafetyHold('invoke Reader command');
  assert.ok(nativeCommands.includes(suffix), `Unknown native Reader command: ${suffix}`);
  await assertRuntimeVault(page);
  return page.evaluate(({ vaultPath, id }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before native command');
    const command = app.commands.commands[id];
    if (!command) throw new Error(`Native command is not registered: ${id}`);
    if (command.checkCallback?.(true) === false) throw new Error(`Native command is unavailable in this leaf: ${id}`);
    if (app.commands.executeCommandById(id) === false) throw new Error(`Native command failed: ${id}`);
    return { id, invokedAt: Date.now(), leafId: app.workspace.activeLeaf?.id };
  }, { vaultPath, id: `${pluginId}:${suffix}` });
}
