import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMainOperations, importPreflightedMainSandbox, localGitEnvironment, originalRepository, originalSandbox } from './local-main.mjs';
import { repository } from './sandbox.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-main-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts')); await mkdir(join(root, '.git'));
  await cp(join(dirname(fileURLToPath(import.meta.url)), 'sandbox.mjs'), join(root, 'scripts/sandbox.mjs'));
  const safe = await import(pathToFileURL(join(root, 'scripts/sandbox.mjs')).href);
  const state = { branch: 'refs/heads/main', head: 'a'.repeat(40), main: 'a'.repeat(40), tree: 'b'.repeat(40), status: '', flags: 'H scripts/sandbox.mjs\0', root };
  const calls = [];
  const git = async args => {
    calls.push(args);
    if (args[0] === 'symbolic-ref') return state.branch;
    if (args[0] === 'status') return state.status;
    if (args[0] === 'ls-files') return state.flags;
    if (args[1] === '--show-toplevel') return state.root;
    if (args[1] === '--git-path') return join(root, '.git', args[2]);
    return { HEAD: state.head, 'refs/heads/main': state.main, 'HEAD^{tree}': state.tree }[args[2]];
  };
  return { root, safe, state, calls, git, ...createMainOperations({ safe, git }) };
}

test('original-main preflight checks main identity and all untracked changes read-only', async t => {
  const f = await fixture(t);
  const snapshot = await f.preflight();
  assert.deepEqual(snapshot, { commit: f.state.head, tree: f.state.tree });
  assert.deepEqual(f.calls.find(args => args[0] === 'status'), ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']);
  await assert.rejects(lstat(f.safe.sandboxPath), { code: 'ENOENT' });
  for (const [key, value] of [['branch', 'refs/heads/feature'], ['branch', ''], ['head', 'c'.repeat(40)],
    ['status', '?? untracked.txt'], ['status', ' M src/main.ts'], ['root', f.root + '-worktree']]) {
    const old = f.state[key]; f.state[key] = value;
    await assert.rejects(f.preflight()); f.state[key] = old;
  }
  f.state.tree = 'd'.repeat(40);
  await assert.rejects(f.preflight(snapshot), /commit\/tree changed/);
});

test('plain Git preflight rejects dirty/wrong-branch/pending/hidden-index state before importing original helpers', async t => {
  const f = await fixture(t); let imports = 0;
  const load = () => importPreflightedMainSandbox({ repository: f.root, git: f.git, load: async () => { imports++; return f.safe; } });
  for (const [key, value] of [['status', ' M scripts/sandbox.mjs'], ['branch', 'refs/heads/other'],
    ['flags', 'h scripts/build.mjs\0'], ['flags', 'S scripts/sandbox.mjs\0'], ['flags', 's src/main.ts\0']]) {
    const before = f.state[key]; f.state[key] = value;
    await assert.rejects(load()); assert.equal(imports, 0); f.state[key] = before;
  }
  await writeFile(join(f.root, '.git/MERGE_HEAD'), 'pending');
  await assert.rejects(load(), /In-progress/); assert.equal(imports, 0);
  await rm(join(f.root, '.git/MERGE_HEAD'));
  assert.equal(await load(), f.safe); assert.equal(imports, 1);
});

test('rejects in-progress Git operations including worktree-specific git paths', async t => {
  const f = await fixture(t);
  for (const name of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG',
    'rebase-apply', 'rebase-merge', 'sequencer', 'index.lock', 'HEAD.lock', 'packed-refs.lock', 'refs/heads/main.lock']) {
    const path = join(f.root, '.git', name);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'in-progress');
    await assert.rejects(f.preflight(), /In-progress Git operation/);
    await rm(path);
  }
});

test('shared exclusive operation lock releases only its own empty lock, including errors', async t => {
  const f = await fixture(t), lock = join(f.safe.sandboxPath, 'local-main-operation.lock');
  await f.withMainOperation(async ({ snapshot, guard, preflight }) => {
    assert.ok((await lstat(lock)).isDirectory());
    assert.deepEqual(await guard(), snapshot);
    await assert.rejects(f.withMainOperation(() => assert.fail('must not enter')), /lock exists/);
    f.state.main = f.state.head = 'c'.repeat(40);
    await assert.rejects(guard(), /commit\/tree changed/);
    assert.equal((await preflight()).commit, f.state.head);
  });
  await assert.rejects(lstat(lock), { code: 'ENOENT' });
  await assert.rejects(f.withMainOperation(async () => { throw new Error('callback failed'); }), /callback failed/);
  await assert.rejects(lstat(lock), { code: 'ENOENT' });
  await mkdir(lock);
  await assert.rejects(f.withMainOperation(() => assert.fail()), /stale lock manually/);
  assert.ok((await lstat(lock)).isDirectory());
});

test('symlinked lock/sandbox/root fail closed without following links', async t => {
  const f = await fixture(t), other = join(f.root, 'other'); await mkdir(other);
  await symlink(other, f.safe.sandboxPath);
  await assert.rejects(f.withMainOperation(() => assert.fail()), /symlink/);
  await rm(f.safe.sandboxPath); await mkdir(f.safe.sandboxPath);
  await symlink(other, join(f.safe.sandboxPath, 'local-main-operation.lock'));
  await assert.rejects(f.withMainOperation(() => assert.fail()), /symlink/);
  const alias = join(f.root, 'alias'); await symlink(f.root, alias);
  const ops = createMainOperations({ safe: { ...f.safe, repository: alias }, git: async () => assert.fail() });
  await assert.rejects(ops.preflight(), /symlinked/);
});

test('production context is fixed, explicit acceptance required, Git location/index overrides rejected', async t => {
  assert.equal(originalRepository, repository);
  const env = process.env.READER_RUNTIME_TARGET;
  try {
    delete process.env.READER_RUNTIME_TARGET;
    await assert.rejects(originalSandbox(), /Explicit READER_RUNTIME_TARGET=acceptance/);
    process.env.READER_RUNTIME_TARGET = 'default';
    await assert.rejects(originalSandbox(), /Explicit READER_RUNTIME_TARGET=acceptance/);
  } finally { if (env === undefined) delete process.env.READER_RUNTIME_TARGET; else process.env.READER_RUNTIME_TARGET = env; }
  const f = await fixture(t);
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) {
    const previous = process.env[key]; process.env[key] = '/wrong';
    try {
      assert.throws(localGitEnvironment, /override is not allowed/);
      await assert.rejects(f.preflight(), /override is not allowed/);
      await assert.rejects(f.withMainOperation(() => assert.fail()), /override is not allowed/);
      await assert.rejects(lstat(f.safe.sandboxPath), { code: 'ENOENT' });
    } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  }
});
