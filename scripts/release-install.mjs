// Shared by local-main reload tooling and explicit release-asset installation.
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import * as sandbox from './sandbox.mjs';
import { releaseInstallFiles } from './release-install-files.mjs';
import { validateArtifacts } from './release-artifacts.mjs';

export const originalRepository = sandbox.repository;
const pluginPrefix = '.obsidian/plugins/obsidian-reader/';
const artifactPaths = sandbox.pluginFiles.map(name => pluginPrefix + name);
const workspace = path => /^\.obsidian\/workspace(?:-mobile)?\.json$/.test(path);
export function assertInstallAuthorization(request, context) {
  assert.equal(request.install, true, 'Explicit --install required');
  assert.equal(request.repo, 'wannli/obsidian-reader', 'Acceptance installation only permits wannli/obsidian-reader');
  assert.match(request.expectedSha ?? '', /^[a-f0-9]{40}$/, '--install requires --expected-sha FULL_SHA');
  assert.equal(request.commit, request.expectedSha, 'Verified commit differs from install authorization');
  assert.equal(context.runtimeTarget, 'acceptance', 'READER_RUNTIME_TARGET=acceptance required');
  assert.equal(context.repository, originalRepository, 'Installation only runs from the exact original checkout, never a worktree');
  assert.equal(context.vaultPath, originalRepository + '/.sandbox/Reader2 Acceptance Vault');
}

export async function installRelease(request) {
  assertInstallAuthorization(request, sandbox);
  assert.equal(process.env.READER_RUNTIME_TARGET, 'acceptance', 'Explicit READER_RUNTIME_TARGET=acceptance required');
  assert.equal(await realpath(sandbox.repository), originalRepository, 'Original checkout must not be symlinked');
  assert.equal(await realpath(process.cwd()), originalRepository, 'Run installer from the original checkout root');
  await sandbox.assertOwnedVault();
  const { releaseInstallRuntime } = await import('./release-install-runtime.mjs');
  return installVerifiedRelease(request, { storage: releaseInstallFiles(sandbox), connect: releaseInstallRuntime });
}

export function inventoryChanges(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(path => before[path] !== after[path])
    .map(path => ({ path, before: before[path] ?? null, after: after[path] ?? null }));
}

// Dependency-injected transaction shared with temp-fixture tests. The public
// installRelease entry point above cannot accept an override of its fixed target.
export async function installVerifiedRelease(request, { storage, connect }) {
  assert.equal(request.install, true);
  assert.match(request.expectedSha ?? '', /^[a-f0-9]{40}$/);
  assert.equal(request.commit, request.expectedSha);
  const files = Object.fromEntries(sandbox.pluginFiles.map(name => [name, Buffer.from(request.files[name])]));
  assert.deepEqual(request.assets.map(asset => asset.name).sort(), [...sandbox.pluginFiles].sort());
  const verified = validateArtifacts(files, request.assets, request.version);
  assert.equal(verified.buildId, request.buildId);
  const result = { status: 'installing', version: request.version, commit: request.commit, buildId: verified.buildId,
    backup: null, replaced: [], noteChanges: [], settingsPreserved: false, loadedBuildId: null };
  let unlock, runtime, staging, shutdownAttempted = false;
  try {
    await storage.guard(); unlock = await storage.lock();
    runtime = await connect(); await runtime.guard();
    const session = await runtime.capture(); // Refuses disabled plugins, dirty editors and dialogs.
    const preShutdown = await storage.inventory();
    shutdownAttempted = true; await runtime.unload();
    await storage.guard();
    const before = await storage.inventory();
    assert.deepEqual(inventoryChanges(preShutdown, before).filter(change => change.path.startsWith('.obsidian/') && !workspace(change.path)), [],
      'Plugin shutdown changed persisted settings or plugin files');
    for (const path of artifactPaths) assert.ok(before[path], `Missing installed artifact: ${path}`);
    result.backup = await storage.backup(before); // Full verified vault copy includes notes, metadata and plugin originals.
    staging = await storage.stage(files);
    await runtime.guard(); await storage.guard();
    assert.deepEqual(await storage.inventory(), before, 'Vault changed after backup; installation cancelled');
    for (const name of sandbox.pluginFiles) {
      await runtime.guard();
      await storage.replace(staging, name, before[pluginPrefix + name], verified.hashes[name]);
      result.replaced.push(name);
    }
    result.installedFiles = await storage.installed();
    assert.deepEqual(result.installedFiles, verified.hashes, 'Installed artifacts differ from downloaded release');
    await storage.guard(); await runtime.guard();
    await runtime.activate(); // Backup is complete before conversion-capable load.
    const loaded = await runtime.verify(verified.buildId);
    assert.equal(loaded.buildId, verified.buildId, 'Loaded build ID mismatch');
    assert.equal(loaded.manifest.version, request.version, 'Loaded manifest version mismatch');
    result.loadedBuildId = loaded.buildId;
    result.session = await runtime.restore(session);
    await runtime.assertClean();
    await storage.guard();
    const after = await storage.inventory();
    result.changes = inventoryChanges(before, after).filter(change => !artifactPaths.includes(change.path));
    // Workspace layout is restored by the runtime session guard; native Obsidian
    // may persist that layout. All settings and other plugins must be byte-identical.
    const configChanges = result.changes.filter(change => change.path.startsWith('.obsidian/') && !workspace(change.path));
    assert.deepEqual(configChanges, [], 'Vault settings or unrelated plugins changed during reload');
    result.settingsPreserved = true;
    result.noteChanges = result.changes.filter(change => !change.path.startsWith('.obsidian/'));
    for (const change of result.noteChanges) {
      const metadata = /^Reading\/(?:Metadata|Pullman Metadata)(?:\/|$)/.test(change.path);
      const convertedNote = change.path.endsWith('.md') && change.before !== null && change.after !== null;
      assert.ok(metadata || convertedNote, `Unexpected non-conversion change: ${change.path}`);
    }
    // Startup conversion can legitimately change Markdown and sidecars. Report every
    // change and keep the backup; do not call this byte-for-byte note preservation.
    assert.deepEqual(await storage.installed(), verified.hashes, 'Installed files changed during reload');
    await runtime.resume(); await runtime.assertClean();
    result.status = result.noteChanges.length ? 'installed-with-note-changes' : 'installed';
    result.notePreservation = result.noteChanges.length ? 'Startup changed vault files; review listed changes against the full backup. Semantic preservation is not automatically proven.' : 'No note/metadata byte changes observed during installation';
  } catch (error) {
    result.status = 'failed'; result.error = String(error.message ?? error);
    if (error.partialBackup) result.partialBackup = error.partialBackup;
    // Never reload a partial replacement or automatically roll back notes/settings.
    if (runtime && shutdownAttempted) {
      try {
        await runtime.unload(); result.leftUnloaded = true;
        result.runtimeState = await runtime.state?.();
        result.persistedEnablement = 'Not disabled by installer; a later app restart may reload the installed files. Inspect backup/replaced list before restarting.';
      }
      catch (cleanupError) { result.shutdownError = String(cleanupError); }
    }
    result.recovery = 'Inspect backup and replaced list; no automatic rollback, reset, enablement change or retry was attempted.';
    error.installation = result; throw error;
  } finally {
    const cleanupErrors = [];
    for (const action of [() => staging && storage.cleanup(staging), () => runtime?.close(), () => unlock?.()]) {
      try { await action(); } catch (error) { cleanupErrors.push(String(error)); }
    }
    if (cleanupErrors.length) {
      result.cleanupErrors = cleanupErrors;
      if (result.status !== 'failed') { const error = new Error('Installation cleanup failed'); result.status = 'failed'; error.installation = result; throw error; }
    }
  }
  return result;
}
