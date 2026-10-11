import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const source = dirname(fileURLToPath(import.meta.url));
const files = ['sandbox.mjs', 'safety-hold.mjs', 'artifacts.mjs', 'build.mjs', 'setup-vault.mjs', 'seed.mjs'];
export async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reader-tooling-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const name of files) await cp(join(source, name), join(root, 'scripts', name));
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const vault = join(root, '.sandbox', 'Reader2 Test Vault');
  const plugin = join(vault, '.obsidian', 'plugins', 'obsidian-reader');
  function run(script = 'setup-vault.mjs', args = []) {
    const result = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    return { ...result, output: result.stdout + result.stderr };
  }
  async function build(version = 'v1') {
    const artifacts = {
      'main.js': `module.exports = ${JSON.stringify(version)};\n`,
      'styles.css': `.reader { --build: ${version}; }\n`,
      'manifest.json': JSON.stringify({ id: 'obsidian-reader', version, isDesktopOnly: false }),
    };
    const metadata = {
      schemaVersion: 1, buildId: 'a'.repeat(64), plugin: { id: 'obsidian-reader', version }, platform: 'browser', external: ['obsidian'],
      artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, { sha256: createHash('sha256').update(value).digest('hex') }])),
    };
    await mkdir(join(root, 'dist'), { recursive: true });
    for (const [name, value] of Object.entries(artifacts)) await writeFile(join(root, 'dist', name), value);
    await writeFile(join(root, 'dist', 'build-meta.json'), JSON.stringify(metadata));
    return artifacts;
  }
  async function enableBuild() {
    await symlink(join(source, '..', 'node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(join(root, 'manifest.json'), '{"id":"obsidian-reader","version":"0.1.0","isDesktopOnly":false}\n');
    await writeFile(join(root, 'styles.css'), '.r2-app {}\n');
    await mkdir(join(root, 'src'));
  }
  await build();
  return { root, vault, plugin, run, build, enableBuild };
}

export async function snapshot(root) {
  const result = {};
  async function walk(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name, path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path, name + '/');
      else result[name] = { bytes: (await readFile(path)).toString('base64'), mtime: (await stat(path)).mtimeMs };
    }
  }
  await walk(root);
  return result;
}
