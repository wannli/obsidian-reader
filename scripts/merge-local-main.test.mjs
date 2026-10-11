import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeLocalMain, parseArgs, commitMessage } from './merge-local-main.mjs';
import { createMainOperations } from './local-main.mjs';

function fixture(t, { conflict = false } = {}) {
  const source = realpathSync(mkdtempSync(join(tmpdir(), 'local-main-merge-')));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name, value) => writeFileSync(join(source, name), value);
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
  write('.gitignore', '.sandbox/\n'); write('file', 'base\n');
  git('add', '.'); git('commit', '-m', 'test: initial');
  const initial = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'feature'); write('file', 'feature\n');
  git('add', '.'); git('commit', '-m', 'test: feature');
  const target = git('rev-parse', 'HEAD'); git('checkout', 'main');
  if (conflict) { write('file', 'main\n'); git('add', '.'); git('commit', '-m', 'test: diverge'); }
  const sandboxPath = join(source, '.sandbox');
  const safe = { repository: source, sandboxPath,
    directory: async path => mkdirSync(path, { recursive: true }), assertSafePath: async () => {} };
  const common = createMainOperations({ safe });
  let checks = 0;
  const calls = [];
  const invoke = (options = {}, check = () => {}) => mergeLocalMain({
    source, branch: 'feature', guard: common.preflight, withLock: common.withMainOperation,
    run: (command, args, config) => {
      calls.push([command, ...args]);
      if (command === 'mise') {
        checks++;
        assert.deepEqual(args.slice(0, 4), ['exec', '--', 'npm', 'run']);
        assert.ok(['validate:metadata', 'typecheck', 'build'].includes(args[4]));
        if (args[4] === 'build') {
          assert.notEqual(git('rev-parse', 'HEAD'), initial, 'Build runs after merge commit');
          assert.equal(git('status', '--porcelain'), '');
        }
        assert.ok(lstatSync(join(sandboxPath, 'local-main-operation.lock')).isDirectory());
        check(config.env, args[4]); return '';
      }
      return execFileSync(command, args, { ...config, stdio: ['ignore', 'pipe', 'pipe'] });
    }, ...options,
  });
  return { source, git, write, initial, target, invoke, calls, sandboxPath, checks: () => checks };
}

test('explicit branch-only CLI and bounded messages', () => {
  for (const args of [[], ['--dry-run'], ['a', 'b'], ['--bad'], ['a', '--dry-run', '--dry-run']])
    assert.throws(() => parseArgs(args), /Usage/);
  assert.deepEqual(parseArgs(['feature', '--dry-run']), { branch: 'feature', dryRun: true });
  assert.equal(commitMessage('feature'), 'chore(integration): merge feature into local main');
  assert.ok(commitMessage('a'.repeat(200)).length <= 72);
});
test('merge checks staged tree under shared lock, creates two-parent commit and no publication', async t => {
  const f = fixture(t);
  const result = await f.invoke();
  assert.equal(result.status, 'merged'); assert.equal(result.target, f.target);
  assert.equal(f.git('show', '-s', '--format=%P', result.sha), `${f.initial} ${f.target}`);
  assert.equal(f.git('status', '--porcelain'), ''); assert.equal(f.checks(), 3);
  assert.ok(!f.calls.some(call => call.some(arg => ['push', 'tag', 'reset', 'abort', 'add'].includes(arg))));
  const again = await f.invoke(); assert.equal(again.status, 'noop'); assert.equal(again.sha, result.sha);
  assert.equal(f.checks(), 3);
});
test('check subprocess does not inherit acceptance-vault authorization', async t => {
  const previous = process.env.READER_RUNTIME_TARGET;
  process.env.READER_RUNTIME_TARGET = 'acceptance';
  t.after(() => {
    if (previous === undefined) delete process.env.READER_RUNTIME_TARGET;
    else process.env.READER_RUNTIME_TARGET = previous;
  });
  const f = fixture(t);
  const result = await f.invoke({}, env => {
    assert.equal(env.READER_RUNTIME_TARGET, undefined, 'Synthetic tests must choose their own vault context');
    assert.equal(process.env.READER_RUNTIME_TARGET, 'acceptance', 'Parent operation keeps its authorization');
  });
  assert.equal(result.status, 'merged');
  assert.equal(process.env.READER_RUNTIME_TARGET, 'acceptance');
});
test('failed post-commit build preserves the integration and never claims a successful build', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke({}, (_env, command) => {
    if (command === 'build') throw new Error('build failed');
  }), /build failed.*\nIntegration stopped/s);
  assert.notEqual(f.git('rev-parse', 'HEAD'), f.initial);
  assert.equal(f.git('status', '--porcelain'), '');
});
test('post-commit source drift blocks successful integration result', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke({}, (_env, command) => {
    if (command === 'build') f.write('file', 'concurrent change');
  }), /state preserved/);
  assert.match(f.git('status', '--porcelain'), /file/);
});
test('dry-run performs no writes and pins target', async t => {
  const f = fixture(t); const result = await f.invoke({ dryRun: true });
  assert.equal(result.target, f.target); assert.equal(result.status, 'dry-run');
  assert.equal(f.git('rev-parse', 'HEAD'), f.initial); assert.equal(f.checks(), 0);
  assert.throws(() => lstatSync(f.sandboxPath), /ENOENT/);
  assert.ok(!f.calls.some(call => call.includes('write-tree') || call.includes('merge') || call.includes('commit')));
});
test('rejects invalid, remote, SHA and missing targets without merge', async t => {
  const f = fixture(t);
  for (const branch of ['--help', 'refs/heads/feature', 'feature~1', 'feature;echo bad', f.target, 'origin/feature', 'missing'])
    await assert.rejects(f.invoke({ branch }));
  assert.equal(f.git('rev-parse', 'HEAD'), f.initial);
});
test('dirty/untracked source, wrong branch, active operation and shared lock refuse', async t => {
  const f = fixture(t);
  f.write('untracked', 'mine'); await assert.rejects(f.invoke(), /clean/);
  rmSync(join(f.source, 'untracked')); f.git('checkout', 'feature');
  await assert.rejects(f.invoke(), /main/); f.git('checkout', 'main');
  f.write('.git/MERGE_HEAD', f.target); await assert.rejects(f.invoke(), /In-progress/);
  rmSync(join(f.source, '.git/MERGE_HEAD'));
  mkdirSync(join(f.sandboxPath, 'local-main-operation.lock'));
  await assert.rejects(f.invoke(), /lock exists/);
});
test('conflict leaves merge for human and does not run checks', async t => {
  const f = fixture(t, { conflict: true }); const before = f.git('rev-parse', 'HEAD');
  await assert.rejects(f.invoke(), /state preserved/);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.git('rev-parse', 'MERGE_HEAD'), f.target); assert.equal(f.checks(), 0);
});
for (const kind of ['failed checks', 'unstaged edit', 'staged edit', 'untracked edit', 'target drift', 'HEAD drift']) {
  test(`${kind} refuses commit and preserves human state`, async t => {
    const f = fixture(t);
    await assert.rejects(f.invoke({}, () => {
      if (kind === 'failed checks') throw new Error('test failed');
      if (kind === 'unstaged edit' || kind === 'staged edit') f.write('file', 'concurrent\n');
      if (kind === 'staged edit') f.git('add', 'file');
      if (kind === 'untracked edit') f.write('new', 'concurrent');
      if (kind === 'target drift') f.git('update-ref', 'refs/heads/feature', f.initial);
      if (kind === 'HEAD drift') f.git('symbolic-ref', 'HEAD', 'refs/heads/feature');
    }), /state preserved/);
    assert.equal(f.git('rev-parse', 'refs/heads/main'), f.initial);
    assert.equal(f.git('rev-parse', 'MERGE_HEAD'), f.target);
  });
}
