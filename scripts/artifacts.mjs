import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pluginFiles, pluginId, regularFile, repository } from './sandbox.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readBuild() {
  const dist = join(repository, 'dist');
  const metadata = JSON.parse(await regularFile(join(dist, 'build-meta.json')));
  if (metadata.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(metadata.buildId ?? '')
    || metadata.platform !== 'browser' || JSON.stringify(metadata.external) !== '["obsidian"]') {
    throw new Error('Missing/invalid browser build identity; run npm run build');
  }
  const files = {};
  for (const name of pluginFiles) {
    files[name] = await regularFile(join(dist, name));
    if (!files[name].length || metadata.artifacts?.[name]?.sha256 !== sha256(files[name])) {
      throw new Error(`Build artifact does not match build-meta.json: ${name}. Run npm run build.`);
    }
  }
  const manifest = JSON.parse(files['manifest.json']);
  if (manifest.id !== pluginId || manifest.isDesktopOnly !== false || metadata.plugin?.id !== pluginId || metadata.plugin?.version !== manifest.version) {
    throw new Error('Unexpected Reader plugin manifest');
  }
  return { metadata, files, manifest };
}
