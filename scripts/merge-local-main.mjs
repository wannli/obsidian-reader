import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE = fileURLToPath(new URL('..', import.meta.url));
export function parseArgs(args) {
  const branches = args.filter(arg => arg !== '--dry-run');
  if (branches.length !== 1 || args.filter(arg => arg === '--dry-run').length > 1 ||
      branches[0].startsWith('-')) throw new Error('Usage: main:merge <local-branch> [--dry-run]');
  return { branch: branches[0], dryRun: args.includes('--dry-run') };
}
export function commitMessage(branch) {
  const prefix = 'chore(integration): merge ', suffix = ' into local main';
  const budget = 72 - prefix.length - suffix.length;
  const name = Array.from(branch);
  return prefix + (name.length > budget ? name.slice(0, budget - 3).join('') + '...' : branch) + suffix;
}

// Only committed local branch content is integrated. Dirty feature worktrees are not read.
// Injection points are for isolated tests; the CLI always uses the fixed original source.
export async function mergeLocalMain({ branch, dryRun = false, source = SOURCE,
  run = execFileSync, guard, withLock } = {}) {
  if (!branch || branch.startsWith('-') || branch.startsWith('refs/') || /[\s\x00-\x1f\x7f]/u.test(branch))
    throw new Error('An explicit local branch name is required (not a ref, SHA, or revision expression)');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args) => run('git', ['--no-optional-locks', ...args],
    { cwd: source, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  git('check-ref-format', `refs/heads/${branch}`);
  if (!guard || !withLock) {
    const common = await import('./local-main.mjs');
    if (source !== SOURCE) throw new Error('Production source is fixed; fixtures must inject guards and lock');
    guard ??= () => common.originalMainPreflight();
    withLock ??= common.withMainOperation;
  }
  const operation = async () => {
    await guard();
    const initial = git('rev-parse', 'HEAD').trim();
    const targetRef = `refs/heads/${branch}`;
    const target = git('rev-parse', '--verify', `${targetRef}^{commit}`).trim();
    let ancestor = false;
    try { git('merge-base', '--is-ancestor', target, initial); ancestor = true; }
    catch (error) { if (error.status !== 1) throw error; }
    if (ancestor) return { status: 'noop', sha: initial, target };
    if (dryRun) return { status: 'dry-run', sha: initial, target, branch };
    const stable = (merging = false) => {
      if (git('symbolic-ref', 'HEAD').trim() !== 'refs/heads/main' ||
          git('rev-parse', 'HEAD').trim() !== initial ||
          git('rev-parse', 'refs/heads/main').trim() !== initial ||
          git('rev-parse', '--verify', `${targetRef}^{commit}`).trim() !== target)
        throw new Error('Branch or HEAD drift detected; inspect manually');
      if (merging && git('rev-parse', '--verify', 'MERGE_HEAD').trim() !== target)
        throw new Error('Merge target drift detected; inspect manually');
    };
    const fingerprint = () => JSON.stringify([
      git('write-tree').trim(),
      git('diff', '--binary', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none'),
      git('ls-files', '--others', '--exclude-standard', '-z'),
      git('status', '--porcelain=v1', '--untracked-files=all'),
    ]);
    stable();
    try {
      git('merge', '--no-ff', '--no-commit', target);
      stable(true);
      if (git('diff', '--binary', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none') ||
          git('ls-files', '--others', '--exclude-standard', '-z'))
        throw new Error('Unexpected unstaged or untracked changes after merge');
      const before = fingerprint();
      // A merge stages its result itself. Never git add: that could absorb unrelated edits.
      // Source checks/build never inherit vault authorization from the caller.
      const checkEnv = { ...env };
      delete checkEnv.READER_RUNTIME_TARGET;
      for (const command of ['validate:metadata', 'typecheck'])
        run('mise', ['exec', '--', 'npm', 'run', command], { cwd: source, env: checkEnv, stdio: 'inherit' });
      stable(true);
      if (fingerprint() !== before) throw new Error('Integrated tree/index changed during checks');
      git('commit', '-m', commitMessage(branch));
      const sha = git('rev-parse', 'HEAD').trim();
      await guard();
      const committed = fingerprint();
      run('mise', ['exec', '--', 'npm', 'run', 'build'], { cwd: source, env: checkEnv, stdio: 'inherit' });
      await guard();
      if (git('rev-parse', 'HEAD').trim() !== sha || fingerprint() !== committed)
        throw new Error('Committed source changed during build; artifacts must not be installed');
      return { status: 'merged', sha, target, branch, built: true };
    } catch (error) {
      throw new Error(`${error.message}\nIntegration stopped; state preserved for human inspection. No automatic reset/abort.`, { cause: error });
    }
  };
  // Dry-run performs only read operations, including no lock-file creation.
  return dryRun ? operation() : withLock(operation);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await mergeLocalMain(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    console.log('Approved integration rebuilds committed main only. No push, tag, version bump, vault install or reload performed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
