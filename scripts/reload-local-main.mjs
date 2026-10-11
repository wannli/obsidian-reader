#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createMainOperations, localGitEnvironment, originalSandbox } from './local-main.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const commands = ['typecheck', 'build'];
export const localMainExitCode = result => result.status === 'installed-with-note-changes' ? 2 : 0;
export function parseLocalMainArgs(args) {
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--dry-run'), 'Only --dry-run is accepted; no source/vault/force overrides');
  return { dryRun: args.length === 1 };
}

// All injection is explicit and confined to this factory; CLI uses fixed production dependencies below.
export function createLocalMainReload({ safe, operations, command, prepare }) {
  const plan = snapshot => ({ mode: 'local-development', status: 'dry-run', ...snapshot,
    source: safe.repository, vaultPath: safe.vaultPath, commands: commands.map(name => `mise exec -- npm run ${name}`) });
  return async function reload({ dryRun = false } = {}) {
    if (dryRun) { // No lock, dependency imports, build, evidence or CDP.
      const snapshot = await operations.preflight(); await safe.assertOwnedVault(); return plan(snapshot);
    }
    return operations.withMainOperation(async ({ snapshot, guard }) => {
      const receipt = { mode: 'local-development', status: 'failed', commit: snapshot.commit, tree: snapshot.tree,
        stage: 'vault-preflight', version: null, buildId: null };
      let failure;
      try {
        await safe.assertOwnedVault(); // Reject missing ownership before any build or CDP connection.
        receipt.stage = 'dependencies';
        await safe.assertSafePath(join(safe.repository, 'node_modules'), 'directory');
        try { assert.ok((await lstat(join(safe.repository, 'node_modules'))).isDirectory()); }
        catch { throw new Error('Dependencies missing; run mise exec -- npm ci in the original checkout. Dependencies are never installed automatically.'); }
        for (const name of commands) {
          receipt.stage = name;
          await guard();
          try { await command('mise', ['exec', '--', 'npm', 'run', name], { cwd: safe.repository }); }
          catch (error) { throw new Error(`${name} failed; if dependencies are missing/stale, run mise exec -- npm ci in the original checkout. No automatic install.`, { cause: error }); }
          await guard();
        }
        receipt.stage = 'validate-build';
        const { readBuild, verifyBuildInputs, storage, connect, install } = await prepare();
        const build = await readBuild();
        assert.match(build.metadata.inputs?.['src/main.ts'] ?? '', /^[a-f0-9]{64}$/, 'Build metadata must identify source inputs');
        const hashes = Object.fromEntries(safe.pluginFiles.map(name => [name, sha256(build.files[name])]));
        const guardBuild = async () => {
          await guard(); await verifyBuildInputs(build); await operations.verifyBuildSnapshot(snapshot, build);
          const current = await readBuild();
          assert.deepEqual(current.metadata, build.metadata, 'Build metadata changed during local reload');
          for (const name of safe.pluginFiles) assert.equal(sha256(current.files[name]), hashes[name], `Local build changed: ${name}`);
          await guard();
        };
        await guardBuild();
        receipt.version = build.manifest.version; receipt.buildId = build.metadata.buildId;
        // Digests describe actual local bytes, not a GitHub release or provenance claim.
        const request = { mode: 'local-development', install: true, commit: snapshot.commit, expectedSha: snapshot.commit,
          version: receipt.version, buildId: receipt.buildId, files: build.files,
          assets: safe.pluginFiles.map(name => ({ name, size: build.files[name].length, digest: 'sha256:' + hashes[name] })) };
        const installedGuard = async () => { await guardBuild(); assert.deepEqual(await storage.installed(), hashes, 'Installed local snapshot changed'); };
        const guardedStorage = { ...storage,
          guard: async () => { await guardBuild(); await storage.guard(); },
          replace: async (...args) => { await guardBuild(); return storage.replace(...args); },
        };
        const guardedConnect = async () => {
          await guardBuild();
          const runtime = await connect();
          return { ...runtime,
            activate: async () => { await installedGuard(); return runtime.activate(); },
            verify: async (...args) => { await installedGuard(); const result = await runtime.verify(...args); await installedGuard(); return result; },
            resume: async () => { await installedGuard(); const result = await runtime.resume(); await installedGuard(); return result; },
          };
        };
        receipt.stage = 'install';
        const result = await install(request, { storage: guardedStorage, connect: guardedConnect });
        Object.assign(receipt, narrowResult(result));
        receipt.stage = 'complete';
      } catch (error) {
        failure = error;
        Object.assign(receipt, narrowResult(error.installation ?? {}), { status: 'failed', errorType: error.name });
      }
      // Never serialize runtime sessions, settings, note names/content, or raw assertion errors.
      const directory = join(safe.sandboxPath, 'evidence/local-main');
      try {
        await safe.directory(directory);
        receipt.evidence = join(directory, `${randomUUID()}.json`);
        assert.equal(await safe.createOnly(receipt.evidence, JSON.stringify(receipt, null, 2) + '\n'), true);
      } catch (error) {
        if (failure) throw new AggregateError([failure, error], 'Local reload failed and receipt could not be persisted');
        throw new Error('Local reload completed but receipt could not be persisted', { cause: error });
      }
      if (failure) { failure.receipt = receipt; throw failure; }
      return receipt;
    });
  };
}

function narrowResult(result) {
  return Object.fromEntries(Object.entries({ status: result.status, backup: result.backup?.path ?? result.partialBackup?.path,
    backupVerified: result.backup?.verified ?? result.partialBackup?.verified, replaced: result.replaced,
    settingsPreserved: result.settingsPreserved, loadedBuildId: result.loadedBuildId, leftUnloaded: result.leftUnloaded,
    noteChangeCount: result.noteChanges?.length, installedFiles: result.installedFiles,
    cleanupFailureCount: result.cleanupErrors?.length }).filter(([, value]) => value !== undefined));
}

export async function reloadLocalMain(options = {}) {
  const safe = await originalSandbox();
  const originalImport = name => import(pathToFileURL(join(safe.repository, 'scripts', name)).href);
  const reload = createLocalMainReload({ safe, operations: createMainOperations({ safe }),
    command: async (file, args, { cwd }) => {
      const { stdout, stderr } = await exec(file, args, { cwd, env: localGitEnvironment(), maxBuffer: 16 * 1024 * 1024 });
      process.stdout.write(stdout); process.stderr.write(stderr);
    },
    prepare: async () => {
      const [artifacts, plugin, session, cdp, files, runtime, installer] = await Promise.all([
        originalImport('artifacts.mjs'), originalImport('runtime-plugin.mjs'), originalImport('runtime-session.mjs'), originalImport('cdp.mjs'),
        import('./release-install-files.mjs'), import('./release-install-runtime.mjs'), import('./release-install.mjs'),
      ]);
      return { readBuild: artifacts.readBuild, verifyBuildInputs: plugin.verifyBuildInputs,
        storage: files.releaseInstallFiles(safe), install: installer.installVerifiedRelease,
        connect: async () => runtime.createReleaseInstallRuntime(await cdp.connectToTestVault(), {
          assertRuntimeVault: cdp.assertRuntimeVault, captureSession: session.captureSession,
          restoreSession: session.restoreSession, verifyReader: plugin.verifyReader,
        }, { pluginId: safe.pluginId, vaultPath: safe.vaultPath }),
      };
    },
  });
  return reload(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await reloadLocalMain(parseLocalMainArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = localMainExitCode(result);
  }
  catch (error) {
    console.error(error.message);
    if (error.receipt) console.error(JSON.stringify(error.receipt, null, 2));
    process.exitCode = 1;
  }
}
