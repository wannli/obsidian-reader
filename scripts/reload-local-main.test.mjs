import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './artifacts.mjs';
import { createMainOperations } from './local-main.mjs';
import { createLocalMainReload, localMainExitCode, parseLocalMainArgs } from './reload-local-main.mjs';
import { releaseInstallFiles } from './release-install-files.mjs';
import { installVerifiedRelease } from './release-install.mjs';

async function fixture(t, hooks = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-reload-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts')); await mkdir(join(root, 'node_modules'));
  await cp(join(dirname(fileURLToPath(import.meta.url)), 'sandbox.mjs'), join(root, 'scripts/sandbox.mjs'));
  const safe = await import(pathToFileURL(join(root, 'scripts/sandbox.mjs')).href);
  await mkdir(safe.pluginPath, { recursive: true });
  await writeFile(join(safe.vaultPath, safe.markerName), JSON.stringify(safe.ownership));
  for (const name of safe.pluginFiles) await writeFile(join(safe.pluginPath, name), 'old-' + name);
  await writeFile(join(safe.pluginPath, 'data.json'), '{"secret":"KEEP SETTINGS"}');
  await writeFile(join(safe.vaultPath, 'Private note.md'), 'KEEP NOTE');
  const version = '0.1.9', manifest = { id: 'obsidian-reader', name: 'Reader', version, description: 'Reader', author: 'Author', minAppVersion: '1.8.7', isDesktopOnly: false };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)), styles = Buffer.from('.reader {}'), bundled = Buffer.from('// fixture; never execute\n');
  const buildId = sha256(Buffer.concat([bundled, manifestBytes, styles]));
  const files = { 'main.js': Buffer.concat([bundled, Buffer.from(`\nObject.defineProperty(module.exports.default ?? module.exports, '__readerBuildId', { value: "${buildId}" });\n`)]),
    'manifest.json': manifestBytes, 'styles.css': styles };
  const build = { files, manifest, metadata: { buildId, inputs: { 'src/main.ts': sha256('source') } } };
  const state = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), status: '', inputChanged: false }, events = [];
  const git = async args => {
    if (args[0] === 'status') return state.status;
    if (args[0] === 'ls-files') return 'H scripts/build.mjs\0';
    if (args[0] === 'symbolic-ref') return 'refs/heads/main';
    if (args[1] === '--show-toplevel') return root;
    if (args[1] === '--git-path') return join(root, '.git', args[2]);
    return args[2] === 'HEAD^{tree}' ? state.tree : state.commit;
  };
  const base = releaseInstallFiles(safe);
  const storage = Object.fromEntries(Object.entries(base).map(([name, fn]) => [name, async (...args) => {
    events.push(name); const result = await fn(...args); await hooks[name]?.(state, result); return result;
  }]));
  const runtime = {
    guard: async () => { await hooks.runtimeGuard?.(state, events); }, capture: async () => ({ privateSession: 'DO NOT PERSIST' }),
    unload: async () => { events.push('unload'); }, activate: async () => { events.push('activate'); await hooks.activate?.(state); },
    verify: async () => { await hooks.verify?.(state); return { buildId, manifest }; },
    restore: async () => ({ privateSession: 'DO NOT PERSIST' }), assertClean: async () => {},
    resume: async () => { events.push('resume'); await hooks.resume?.(state); }, close: async () => { events.push('close'); },
  };
  const blobs = { 'src/main.ts': Buffer.from('source'), 'manifest.json': Buffer.from(manifestBytes), 'styles.css': Buffer.from(styles) };
  const readBlob = async (commit, path) => {
    assert.equal(commit, 'a'.repeat(40));
    if (!blobs[path]) throw new Error('not in captured commit');
    return blobs[path];
  };
  const run = createLocalMainReload({ safe, operations: createMainOperations({ safe, git, readBlob }),
    command: async (file, args, options) => {
      assert.equal(file, 'mise'); assert.deepEqual(args.slice(0, 4), ['exec', '--', 'npm', 'run']); assert.equal(options.cwd, root);
      events.push(args[4]); await hooks.command?.(state, args[4]);
    },
    prepare: async () => {
      events.push('prepare');
      return { readBuild: async () => { await hooks.readBuild?.(state, build); return structuredClone(build); },
        verifyBuildInputs: async () => { assert.equal(state.inputChanged, false, 'Source input changed'); }, storage,
        connect: async () => { events.push('connect'); return runtime; }, install: async (req, deps) => {
          assert.equal(req.mode, 'local-development'); assert.equal(req.repo, undefined);
          for (const asset of req.assets) assert.equal(asset.digest, 'sha256:' + sha256(files[asset.name]));
          return installVerifiedRelease(req, deps);
        } };
    },
  });
  return { root, safe, state, events, build, run, storage };
}

test('CLI permits only dry-run; dry-run is read-only with no locks/build/CDP/evidence', async t => {
  assert.deepEqual(parseLocalMainArgs([]), { dryRun: false }); assert.deepEqual(parseLocalMainArgs(['--dry-run']), { dryRun: true });
  assert.equal(localMainExitCode({ status: 'installed-with-note-changes' }), 2);
  for (const status of ['installed', 'dry-run']) assert.equal(localMainExitCode({ status }), 0);
  for (const args of [['--force'], ['--source', '/tmp'], ['--vault', '/tmp'], ['--dry-run', '--dry-run']]) assert.throws(() => parseLocalMainArgs(args));
  const f = await fixture(t), before = await readdir(f.safe.sandboxPath);
  const result = await f.run({ dryRun: true });
  assert.equal(result.mode, 'local-development'); assert.equal(result.commit, f.state.commit);
  assert.deepEqual(f.events, []); assert.deepEqual(await readdir(f.safe.sandboxPath), before);
  f.state.status = '?? untracked'; await assert.rejects(f.run({ dryRun: true }), /clean including untracked/);
});

test('missing/invalid vault ownership blocks before commands/CDP; dependencies require manual npm ci', async t => {
  for (const kind of ['missing-marker', 'invalid-marker', 'dependencies']) {
    const f = await fixture(t);
    if (kind === 'missing-marker') await rm(join(f.safe.vaultPath, f.safe.markerName));
    if (kind === 'invalid-marker') await writeFile(join(f.safe.vaultPath, f.safe.markerName), '{}');
    if (kind === 'dependencies') await rm(join(f.root, 'node_modules'), { recursive: true });
    await assert.rejects(f.run(), kind === 'dependencies' ? /npm ci/ : /ENOENT|ownership marker/);
    assert.deepEqual(f.events, []);
    if (kind !== 'dependencies') await assert.rejects(f.run({ dryRun: true }));
  }
});

test('local bytes install through full backup transaction preserving settings/session and narrow receipt', async t => {
  const f = await fixture(t), receipt = await f.run();
  assert.equal(receipt.status, 'installed'); assert.equal(receipt.mode, 'local-development'); assert.equal(receipt.commit, f.state.commit);
  assert.deepEqual(f.events.slice(0, 3), ['typecheck', 'build', 'prepare']);
  assert.ok(f.events.indexOf('backup') < f.events.indexOf('replace')); assert.ok(f.events.indexOf('replace') < f.events.indexOf('activate'));
  assert.equal(receipt.loadedBuildId, f.build.metadata.buildId); assert.equal(receipt.settingsPreserved, true);
  assert.equal(await readFile(join(receipt.backup, 'vault/Private note.md'), 'utf8'), 'KEEP NOTE');
  assert.equal(await readFile(join(f.safe.pluginPath, 'data.json'), 'utf8'), '{"secret":"KEEP SETTINGS"}');
  const text = await readFile(receipt.evidence, 'utf8');
  assert.doesNotMatch(text, /Private note|KEEP NOTE|KEEP SETTINGS|privateSession|DO NOT PERSIST|github/i);
  assert.deepEqual(JSON.parse(text), receipt);
});

test('source changes after either command stop before preparation or installation', async t => {
  for (const step of ['typecheck', 'build']) {
    const f = await fixture(t, { command: async (state, name) => { if (name === step) state.commit = 'c'.repeat(40); } });
    await assert.rejects(f.run(), /commit\/tree changed/); assert.equal(f.events.includes('prepare'), false);
  }
  const f = await fixture(t, { command: async () => { throw new Error('missing typescript'); } });
  await assert.rejects(f.run(), /npm ci/); assert.deepEqual(f.events, ['typecheck']);
});

test('source/build drift during install refuses further writes and activation, leaves partial unloaded', async t => {
  for (const hook of ['stage', 'replace']) {
    const f = await fixture(t, { [hook]: async state => { state.status = '?? concurrent-source'; } });
    await assert.rejects(f.run(), error => {
      assert.equal(error.installation.leftUnloaded, true);
      assert.equal(error.installation.replaced.length, hook === 'stage' ? 0 : 1);
      assert.ok(error.receipt.backupVerified); return true;
    });
    assert.equal(f.events.includes('activate'), false); assert.equal(f.events.includes('resume'), false);
  }
  const f = await fixture(t, { runtimeGuard: async (state, events) => {
    if (events.filter(e => e === 'replace').length === 3) state.inputChanged = true;
  } });
  await assert.rejects(f.run(), /Source input changed/); assert.equal(f.events.includes('activate'), false);
  for (const hook of ['verify', 'resume']) {
    const after = await fixture(t, { [hook]: async state => { state.tree = 'c'.repeat(40); } });
    await assert.rejects(after.run(), error => {
      assert.match(error.message, /commit\/tree changed/); assert.equal(error.installation.leftUnloaded, true);
      assert.equal(error.receipt.status, 'failed'); return true;
    });
    assert.equal(after.events.includes('resume'), hook === 'resume');
    assert.equal(after.events.filter(event => event === 'unload').length, 2);
  }
});

test('exact-commit verification rejects ignored/untracked inputs and blob mismatches, permits installed dependencies', async t => {
  for (const path of ['src/ignored.ts', 'src/main.ts', 'manifest.json', 'styles.css']) {
    const f = await fixture(t);
    if (['manifest.json', 'styles.css'].includes(path)) f.build.files[path] = Buffer.from('different local bytes');
    else f.build.metadata.inputs[path] = sha256('different local bytes');
    await assert.rejects(f.run(), /absent from captured main|differs from captured main/);
    assert.equal(f.events.includes('connect'), false);
  }
  const f = await fixture(t); f.build.metadata.inputs['node_modules/dependency/index.js'] = sha256('installed dependency');
  assert.equal((await f.run()).mode, 'local-development');
});

test('invalid build input metadata and changed built bytes fail before live connection', async t => {
  const f = await fixture(t); delete f.build.metadata.inputs;
  await assert.rejects(f.run(), /identify source inputs/); assert.equal(f.events.includes('connect'), false);
  let reads = 0;
  const drift = await fixture(t, { readBuild: async (_state, build) => { if (++reads === 2) build.files['styles.css'][0] ^= 1; } });
  await assert.rejects(drift.run(), /Local build changed/); assert.equal(drift.events.includes('connect'), false);
});
