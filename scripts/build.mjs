#!/usr/bin/env node
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertSafePath,
  createOnly,
  directory,
  isMain,
  pluginId,
  pluginPath,
  regularFile,
  repository,
} from './sandbox.mjs';
import { assertDevelopmentVault } from './hot-reload.mjs';

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
export function forbiddenRuntimeImport(name) {
  const normalized = name.replaceAll('\\', '/');
  return (
    normalized.startsWith('node:') ||
    builtins.has(normalized) ||
    builtins.has(normalized.split('/')[0]) ||
    /^(?:electron)(?:\/|$)/.test(normalized) ||
    /(?:^|\/)node_modules\/electron(?:\/|$)/.test(normalized)
  );
}
export const browserOnly = {
  name: 'reader-no-node-or-electron',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
      if (forbiddenRuntimeImport(path)) {
        return {
          errors: [
            {
              text: `Node/Electron import is forbidden in Reader: ${path} (from ${importer || 'entry'})`,
            },
          ],
        };
      }
    });
  },
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function buildPlugin({ development = false } = {}) {
  if (development) await assertDevelopmentVault();
  const dist = development ? pluginPath : join(repository, 'dist');
  await assertSafePath(dist, 'directory');
  const manifestBytes = await regularFile(join(repository, 'manifest.json'));
  const styles = await regularFile(join(repository, 'src/reader/styles.css'));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.id !== pluginId || manifest.isDesktopOnly !== false)
    throw new Error('Expected the mobile-compatible Reader manifest');
  const result = await build({
    absWorkingDir: repository,
    entryPoints: ['src/main.ts'],
    outfile: join(dist, 'main.js'),
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: ['obsidian'],
    plugins: [browserOnly],
    metafile: true,
    write: false,
    sourcemap: false,
    logLevel: 'info',
  });
  for (const [input, info] of Object.entries(result.metafile.inputs)) {
    if (forbiddenRuntimeImport(input)) throw new Error(`Forbidden bundle input: ${input}`);
    for (const imported of info.imports) {
      // Input metadata can mark erased TypeScript-only imports as external.
      // Actual output externals are checked separately below.
      if (forbiddenRuntimeImport(imported.path)) {
        throw new Error(`Unsafe bundle import: ${imported.path}`);
      }
    }
  }
  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.some((imported) => imported.external && imported.path !== 'obsidian'))
      throw new Error('Only obsidian may be external');
  }
  if (result.outputFiles.length !== 1) throw new Error('Expected a single browser bundle');
  const bundled = result.outputFiles[0].contents;
  const buildId = sha256(Buffer.concat([bundled, manifestBytes, styles]));
  // Manual acceptance can identify the loaded constructor, not merely files on disk.
  const main = Buffer.concat([
    bundled,
    Buffer.from(
      `\nObject.defineProperty(module.exports.default ?? module.exports, '__readerBuildId', { value: ${JSON.stringify(buildId)} });\n`,
    ),
  ]);
  const artifacts = { 'main.js': main, 'manifest.json': manifestBytes, 'styles.css': styles };
  const inputs = {};
  for (const input of Object.keys(result.metafile.inputs).sort())
    inputs[input] = sha256(await regularFile(resolve(repository, input)));
  const metadata = {
    schemaVersion: 1,
    buildId,
    builtAt: new Date().toISOString(),
    plugin: { id: manifest.id, version: manifest.version },
    platform: 'browser',
    external: ['obsidian'],
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([name, bytes]) => [
        name,
        { sha256: sha256(bytes), bytes: bytes.length },
      ]),
    ),
    inputs,
    metafile: result.metafile,
    acceptance: { physicalIOS: 'NOT RUN', sync: 'NOT RUN' },
  };
  artifacts['build-meta.json'] = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
  for (const name of Object.keys(artifacts)) await assertSafePath(join(dist, name), 'file');
  await directory(dist);
  const staging = await mkdtemp(join(dist, '.build-'));
  try {
    for (const [name, bytes] of Object.entries(artifacts))
      await createOnly(join(staging, name), bytes);
    // Publish main.js last so Hot Reload sees matching styles and manifest.
    const publishOrder = [
      ...Object.keys(artifacts).filter((name) => name !== 'main.js'),
      'main.js',
    ];
    for (const name of publishOrder) {
      if (development) await assertDevelopmentVault();
      await assertSafePath(join(dist, name), 'file');
      await rename(join(staging, name), join(dist, name));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify(
      { buildId, dist, artifacts: Object.keys(artifacts), external: ['obsidian'] },
      null,
      2,
    ),
  );
  return metadata;
}

if (isMain(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('No build arguments accepted');
  await buildPlugin();
}
