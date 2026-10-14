import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { validateCorpusLocation, validateCorpusMarker } from './benchmark-scale.mjs';
import { assertSafePath, directory, inside, repository, sandboxPath } from './sandbox.mjs';

// Fixture safety only: never runs the scale benchmark or accesses either runtime vault.
const compiled = await build({
  entryPoints: [join(repository, 'tests/benchmarks/fs-vault.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const { FileVault, checkedNotePath } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`
);

async function fixture(t) {
  await directory(sandboxPath);
  const temporary = await mkdtemp(join(sandboxPath, '.scale-safety-'));
  const root = join(temporary, 'corpus');
  await mkdir(root);
  t.after(async () => {
    inside(sandboxPath, temporary);
    await rm(temporary, { recursive: true });
  });
  const guard = async (path, kind) => {
    inside(root, path);
    await assertSafePath(path, kind);
  };
  return { temporary, root, port: new FileVault(root, guard) };
}

test('only a direct hidden run child is a corpus location; ownership fields must match', () => {
  const vault = '/synthetic/fixed-vault',
    root = `${vault}/.reader-benchmarks/run-ABC123`;
  assert.equal(validateCorpusLocation(root, vault), root);
  for (const candidate of [vault, `${vault}/Reading/run-x`, `${root}/Reading`, '/elsewhere/run-x'])
    assert.throws(() => validateCorpusLocation(candidate, vault));
  const marker = {
    schemaVersion: 1,
    purpose: 'Reader isolated offline scale benchmark',
    corpusPath: root,
    vaultPath: vault,
    id: 'unique-run',
  };
  validateCorpusMarker({ ...marker }, marker);
  for (const key of Object.keys(marker))
    assert.throws(() => validateCorpusMarker({ ...marker, [key]: 'wrong' }, marker));
  assert.throws(() => validateCorpusMarker(null, marker));
});

test('note paths cannot address markers, absolute paths, traversal, or backslash aliases', () => {
  for (const path of [
    '../Reading/Inbox/A.md',
    '/Reading/Inbox/A.md',
    'Reading/../A.md',
    'Reading//A.md',
    'Reading/Inbox\\A.md',
    '.reader-scale-corpus.json',
  ])
    assert.throws(() => checkedNotePath('/corpus', path));
  assert.equal(checkedNotePath('/corpus', 'Reading/Inbox/A.md'), '/corpus/Reading/Inbox/A.md');
});

test('exclusive creates/moves never adopt or overwrite an unindexed existing file', async (t) => {
  const { root, port } = await fixture(t),
    first = await port.create('Reading/Inbox/A.md', 'Original');
  await writeFile(join(root, 'Reading/Inbox/Existing.md'), 'Keep me', { flag: 'wx' });
  await assert.rejects(port.create('Reading/Inbox/Existing.md', 'Wrong'));
  await assert.rejects(port.create(first.path, 'Wrong'));
  await assert.rejects(port.move(first, 'Reading/Inbox/Existing.md'));
  assert.equal(await port.read(first), 'Original');
  assert.equal(await readFile(join(root, 'Reading/Inbox/Existing.md'), 'utf8'), 'Keep me');
});

test('a symlink cannot redirect corpus operations to a sibling file', async (t) => {
  const { temporary, root, port } = await fixture(t);
  await mkdir(join(root, 'Reading/Inbox'), { recursive: true });
  const outside = join(temporary, 'outside.md');
  await writeFile(outside, 'Outside stays unchanged', { flag: 'wx' });
  await symlink(outside, join(root, 'Reading/Inbox/Link.md'));
  await assert.rejects(port.create('Reading/Inbox/Link.md', 'Wrong'));
  assert.equal(await readFile(outside, 'utf8'), 'Outside stays unchanged');
});

test('process truncates correctly and moves preserve stable identity without leftover source files', async (t) => {
  const { root, port } = await fixture(t),
    file = await port.create('Reading/Stream/A.md', 'Long original text');
  assert.equal(await port.process(file, () => 'Short'), 'Short');
  assert.equal(await readFile(join(root, file.path), 'utf8'), 'Short');
  await port.move(file, 'Reading/Inbox/A.md');
  assert.equal(port.file(file.path), file);
  assert.equal(port.file('Reading/Stream/A.md'), undefined);
  await assert.rejects(readFile(join(root, 'Reading/Stream/A.md')), { code: 'ENOENT' });
  assert.equal(await port.read(file), 'Short');
  await port.assertFiles();
});
