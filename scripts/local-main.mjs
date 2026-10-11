import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const originalRepository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exec = promisify(execFile);
const operations = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG',
  'rebase-apply', 'rebase-merge', 'sequencer', 'index.lock', 'HEAD.lock', 'packed-refs.lock', 'refs/heads/main.lock'];
export function localGitEnvironment() {
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) {
    assert.equal(process.env[key], undefined, `Git location/index override is not allowed: ${key}`);
  }
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

export async function originalSandbox() {
  localGitEnvironment();
  assert.equal(process.env.READER_RUNTIME_TARGET, 'acceptance', 'Explicit READER_RUNTIME_TARGET=acceptance required');
  const safe = await importPreflightedMainSandbox({ repository: originalRepository,
    load: () => import(pathToFileURL(join(originalRepository, 'scripts/sandbox.mjs')).href) });
  assert.equal(safe.repository, originalRepository);
  assert.equal(safe.runtimeTarget, 'acceptance');
  assert.equal(safe.vaultPath, join(originalRepository, '.sandbox/Reader2 Acceptance Vault'));
  return safe;
}

// Plain Git checks run before executing any helper code from the source checkout.
// Injection is only for isolated fixtures; originalSandbox fixes the production root.
export async function importPreflightedMainSandbox({ repository, git, load }) {
  const { preflight } = createMainOperations({ safe: { repository }, git });
  const snapshot = await preflight();
  const safe = await load();
  await preflight(snapshot);
  return safe;
}

// Injection is for isolated fixtures only; production exports never accept a root override.
export function createMainOperations({ safe, git = async args => (await exec('git',
  ['--no-optional-locks', '-C', safe.repository, ...args], { env: localGitEnvironment() })).stdout.trim(),
  readBlob = async (commit, path) => (await exec('git',
    ['--no-optional-locks', '-C', safe.repository, 'cat-file', 'blob', `${commit}:${path}`],
    { env: localGitEnvironment(), encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })).stdout }) {
  const root = safe.repository;
  async function preflight(expected) {
    localGitEnvironment();
    assert.equal(await realpath(root), root, 'Original checkout must not be symlinked');
    assert.equal(await git(['rev-parse', '--show-toplevel']), root, 'Source must be the original checkout root');
    assert.equal(await git(['symbolic-ref', '--quiet', 'HEAD']), 'refs/heads/main', 'Original checkout must have main checked out');
    for (const name of operations) {
      const path = resolve(root, await git(['rev-parse', '--git-path', name]));
      let exists = false;
      try { await lstat(path); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.equal(exists, false, `In-progress Git operation: ${name}`);
    }
    const commit = await git(['rev-parse', '--verify', 'HEAD']);
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.equal(commit, await git(['rev-parse', '--verify', 'refs/heads/main']), 'HEAD differs from local main');
    const tree = await git(['rev-parse', '--verify', 'HEAD^{tree}']);
    assert.match(tree, /^[a-f0-9]{40}$/);
    const entries = (await git(['ls-files', '-v', '-z'])).split('\0').filter(Boolean);
    assert.equal(entries.some(entry => /^[a-zS]/.test(entry)), false,
      'Assume-unchanged/skip-worktree index flags are forbidden on original main');
    assert.equal(await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']), '',
      'Original main must be clean including untracked files');
    const snapshot = { commit, tree };
    if (expected) assert.deepEqual(snapshot, expected, 'Original main source commit/tree changed');
    return snapshot;
  }
  async function verifyBuildSnapshot(snapshot, build) {
    await preflight(snapshot);
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const inputs = { ...build.metadata.inputs };
    for (const name of ['manifest.json', 'styles.css']) inputs[name] = hash(build.files[name]);
    for (const [path, digest] of Object.entries(inputs)) {
      assert.ok(path && path === relative(root, resolve(root, path)) && path !== '..'
        && !path.startsWith('../') && !path.includes('\\\\'), `Noncanonical build input: ${path}`);
      // Installed dependencies are tooling, not a claim of hermetic release provenance.
      if (path.startsWith('node_modules/')) continue;
      assert.match(digest, /^[a-f0-9]{64}$/, `Invalid build input hash: ${path}`);
      let blob;
      try { blob = await readBlob(snapshot.commit, path); }
      catch (error) { throw new Error(`Build input is absent from captured main commit: ${path}`, { cause: error }); }
      assert.equal(hash(blob), digest, `Build input differs from captured main commit: ${path}`);
    }
    await preflight(snapshot);
  }
  async function withMainOperation(callback) {
    localGitEnvironment();
    await safe.directory(safe.sandboxPath);
    const lock = join(safe.sandboxPath, 'local-main-operation.lock');
    await safe.assertSafePath(lock, 'directory');
    try { await mkdir(lock); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Local-main operation lock exists; inspect active/stale lock manually. No force bypass.');
      throw error;
    }
    const identity = await lstat(lock);
    try {
      const snapshot = await preflight();
      return await callback({ snapshot, guard: () => preflight(snapshot), preflight });
    } finally {
      await safe.assertSafePath(lock, 'directory');
      const current = await lstat(lock);
      assert.equal(current.ino, identity.ino, 'Operation lock changed; refusing removal');
      assert.equal(current.dev, identity.dev, 'Operation lock changed; refusing removal');
      await rmdir(lock);
    }
  }
  return { preflight, withMainOperation, verifyBuildSnapshot };
}

// Source-only operations share the reload lock without importing runtime/vault helpers.
// Root injection is for fixtures; production wrappers below fix the original checkout.
export function createSourceOperations(repository) {
  const sandboxPath = join(repository, '.sandbox');
  const assertSafePath = async path => {
    assert.ok([sandboxPath, join(sandboxPath, 'local-main-operation.lock')].includes(path), 'Unexpected main-lock path');
    assert.equal(await realpath(repository), repository, 'Original checkout must not be symlinked');
    for (const current of [sandboxPath, ...(path === sandboxPath ? [] : [path])]) {
      const stat = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat) assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Unsafe main-lock directory: ${current}`);
    }
  };
  return createMainOperations({ safe: { repository, sandboxPath, assertSafePath,
    directory: async path => {
      assert.equal(path, sandboxPath);
      await assertSafePath(path);
      await mkdir(path, { recursive: true });
      await assertSafePath(path);
    },
  } });
}
export async function originalMainPreflight(expected) {
  return createSourceOperations(originalRepository).preflight(expected);
}
export async function withMainOperation(callback) {
  return createSourceOperations(originalRepository).withMainOperation(callback);
}
